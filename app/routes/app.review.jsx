import { useFetcher } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { getSettingOr } from "../utils/settings";

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

  if (intent !== "fetch") {
    throw new Response("Invalid intent", { status: 400 });
  }

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

  const lastReviewId = formData.get("lastReviewId") || "";
  const pageSize = formData.get("pageSize") || 50;

  const qs = new URLSearchParams();
  if (lastReviewId) qs.set("lastReviewId", lastReviewId);
  qs.set("pageSize", pageSize);

  const res = await fetch(
    // `${MAGENTO_BASE}/rest/V1/mega/shopify/product-reviews?${qs.toString()}`
    `http://dev.megagastrostore.de/rest/V1/shopify/product-reviews?${qs.toString()}`
  );

  if (!res.ok) {
    throw new Response("Failed to fetch reviews", { status: 500 });
  }

  const data = await res.json();

    // data = [total, items]
    const total = Array.isArray(data) ? Number(data[0] || 0) : 0;
    const items = Array.isArray(data) ? data[1] || [] : [];

    return {
    success: true,
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

export default function ReviewPage() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [pageSize] = useState(50);

  const items = fetcher.data?.items ?? [];

  const handleFetch = () => {
    fetcher.submit(
      {
        intent: "fetch",
        pageSize,
      },
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

            <Button
              onClick={handleFetch}
              loading={fetcher.state !== "idle"}
            >
              Fetch reviews
            </Button>
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
                    <IndexTable.Cell>
                      {item.review_id}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {item.sku}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {item.nickname}
                    </IndexTable.Cell>
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
