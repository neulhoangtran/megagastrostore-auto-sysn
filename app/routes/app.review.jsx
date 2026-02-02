import { useFetcher } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { getSettingOr } from "../utils/settings";
import prisma from "../db.server";
import {
  Page,
  Card,
  Button,
  IndexTable,
  Text,
  InlineStack,
  BlockStack,
  Scrollable,
  Badge,
} from "@shopify/polaris";

/**
 * ======================
 * SERVER
 * ======================
 */

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("intent");

  const MAGENTO_BASE = String(
    await getSettingOr("magento_url", "")
  ).trim();

  if (!MAGENTO_BASE) {
    return {
      success: false,
      error: "PLEASE_SETUP_MAGENTO_URL",
      message: "Please setup Magento URL",
    };
  }

  /**
   * ======================
   * FETCH REVIEWS (JSON)
   * ======================
   */
  if (intent === "fetch") {
    const pageSize = formData.get("pageSize") || 50;

    const res = await fetch(
      `http://dev.megagastrostore.de/rest/V1/shopify/product-reviews`
    );

    if (!res.ok) {
      throw new Response("Failed to fetch reviews", { status: 500 });
    }

    const data = await res.json();

    const total = Array.isArray(data) ? Number(data[0] || 0) : 0;
    const items = Array.isArray(data) ? data[1] || [] : [];

    return {
      success: true,
      total,
      items,
    };
  }

  /**
   * ======================
   * EXPORT CSV (FILE)
   * ======================
   */
  if (intent === "export_csv") {
    const res = await fetch(
      `http://dev.megagastrostore.de/rest/V1/shopify/product-reviews`
    );

    if (!res.ok) {
      throw new Response("Failed to fetch reviews", { status: 500 });
    }

    const data = await res.json();
    const items = Array.isArray(data) ? data[1] || [] : [];

    if (!items.length) {
      throw new Response("No reviews to export", { status: 404 });
    }

    // 🔗 Map Magento product_id → Shopify product_id
    const magentoProductIds = [
      ...new Set(items.map((i) => i.product_id).filter(Boolean)),
    ];

    const mappings = await prisma.productMapMagento.findMany({
      where: {
        magentoProductId: { in: magentoProductIds },
      },
      select: {
        magentoProductId: true,
        shopifyProductId: true,
      },
    });

    const productIdMap = new Map(
      mappings.map((m) => [m.magentoProductId, m.shopifyProductId])
    );

    const csvEscape = (value) => {
      if (value === null || value === undefined) return "";
      const str = String(value);
      if (str.includes('"') || str.includes(",") || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const header = [
      "title",
      "body",
      "rating",
      "review_date",
      "reviewer_name",
      "reviewer_email",
      "product_id",
      "product_handle",
      "reply",
      "picture_urls",
    ].join(",");

    const rows = items.map((item) => {
      const shopifyProductId =
        productIdMap.get(item.product_id) || "";

      return [
        csvEscape(item.title),
        csvEscape(item.detail),
        item.rating || "",
        item.created_at ? `${item.created_at} UTC` : "",
        csvEscape(item.nickname),
        "",
        shopifyProductId,
        "",
        "",
        "",
      ].join(",");
    });

    const csv = [header, ...rows].join("\n");

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="magento-reviews-${new Date()
          .toISOString()
          .slice(0, 10)}.csv"`,
      },
    });
  }

  throw new Response("Invalid intent", { status: 400 });
};

/**
 * ======================
 * CLIENT
 * ======================
 */

function RatingBadge({ value }) {
  if (!value) return <Badge tone="subdued">No rating</Badge>;

  const tone =
    value >= 4 ? "success" : value >= 3 ? "attention" : "critical";

  return <Badge tone={tone}>{value} ★</Badge>;
}

export default function ReviewPage() {
  const fetcher = useFetcher();        // ✅ JSON fetch
  const exportFetcher = useFetcher(); // ✅ CSV export
  const shopify = useAppBridge();

  const [pageSize] = useState(50);

  const items = fetcher.data?.items ?? [];

  const handleFetch = () => {
    fetcher.submit(
      { intent: "fetch", pageSize },
      { method: "POST" }
    );
  };

  useEffect(() => {
    const t = setTimeout(handleFetch, 200);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (fetcher.data?.error === "PLEASE_SETUP_MAGENTO_URL") {
      shopify.toast.show("Please setup Magento URL first", {
        isError: true,
      });
    }
  }, [fetcher.data]);

  return (
    <Page title="Product Reviews">
      <BlockStack gap="400">
        <Card>
          <InlineStack align="space-between">
            <Text variant="headingSm">
              Magento → Product Reviews
            </Text>

            <InlineStack gap="200">
              <Button
                onClick={handleFetch}
                loading={fetcher.state !== "idle"}
              >
                Fetch reviews
              </Button>

              <exportFetcher.Form method="post">
                <input type="hidden" name="intent" value="export_csv" />
                <Button
                  variant="primary"
                  submit
                  loading={exportFetcher.state !== "idle"}
                  disabled={!items.length}
                >
                  Export CSV
                </Button>
              </exportFetcher.Form>
            </InlineStack>
          </InlineStack>
        </Card>

        {items.length > 0 && (
          <Card padding="0">
            <Scrollable style={{ height: "650px" }}>
              <IndexTable
                itemCount={items.length}
                selectable={false}
                stickyHeader
                headings={[
                  { title: "Review ID" },
                  { title: "SKU" },
                  { title: "Author" },
                  { title: "Rating" },
                  { title: "Title" },
                  { title: "Content" },
                  { title: "Created At" },
                ]}
              >
                {items.map((item, index) => (
                  <IndexTable.Row
                    id={String(item.review_id)}
                    key={item.review_id}
                    position={index}
                  >
                    <IndexTable.Cell>{item.review_id}</IndexTable.Cell>
                    <IndexTable.Cell>{item.sku}</IndexTable.Cell>
                    <IndexTable.Cell>{item.nickname}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <RatingBadge value={item.rating} />
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {item.title || "-"}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" truncate>
                        {item.detail}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {item.created_at}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Scrollable>
          </Card>
        )}

        {fetcher.state === "idle" && items.length === 0 && (
          <Card>
            <Text>No reviews found</Text>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
