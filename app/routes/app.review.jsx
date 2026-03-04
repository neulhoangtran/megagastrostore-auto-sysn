import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
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
 * CONSTANT
 * ======================
 */
const MAGENTO_API =
  "https://www.megagastrostore.de/rest/V1/shopify/product-reviews";

/**
 * ======================
 * SERVER (LOAD ALL DATA)
 * ======================
 */
export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // 1️⃣ Fetch Magento reviews
  const res = await fetch(MAGENTO_API);
  if (!res.ok) {
    throw new Response("Failed to fetch reviews", { status: 500 });
  }

  const data = await res.json();
  const total = Array.isArray(data) ? Number(data[0] || 0) : 0;
  const reviews = Array.isArray(data) ? data[1] || [] : [];

  if (!reviews.length) {
    return { total: 0, items: [] };
  }

  // 2️⃣ Fetch DB mapping
  const magentoProductIds = [
    ...new Set(reviews.map((r) => r.product_id).filter(Boolean)),
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

  const items = reviews.map((r) => {
    const gid = productIdMap.get(r.product_id) || "";

    const shopifyProductId = gid.startsWith("gid://shopify/Product/")
        ? gid.replace("gid://shopify/Product/", "")
        : gid;

        return {
            ...r,
            shopify_product_id: shopifyProductId,
        };
    });

  return {
    total,
    items,
  };
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

// CSV helpers (CLIENT SIDE)
function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes('"') || str.includes(",") || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function exportReviewsToCsv(items) {
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
  ];

  const rows = items.map((item) => [
    csvEscape(item.title),
    csvEscape(item.detail),
    item.rating || "",
    item.created_at ? `${item.created_at} UTC` : "",
    csvEscape(item.nickname),
    "",
    item.shopify_product_id,
    "",
    "",
    "",
  ]);

  const csv =
    [header.join(","), ...rows.map((r) => r.join(","))].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `magento-reviews-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

export default function ReviewPage() {
  const { items, total } = useLoaderData();

  return (
    <Page title="Product Reviews">
      <BlockStack gap="400">
        <Card>
          <InlineStack align="space-between">
            <Text variant="headingSm">
              Magento → Product Reviews ({total})
            </Text>

            <Button
              variant="primary"
              disabled={!items.length}
              onClick={() => exportReviewsToCsv(items)}
            >
              Export CSV
            </Button>
          </InlineStack>
        </Card>

        {items.length > 0 ? (
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
        ) : (
          <Card>
            <Text>No reviews found</Text>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
