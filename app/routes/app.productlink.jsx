import { useFetcher } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettingOr } from "../utils/settings";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Page,
  Card,
  Button,
  IndexTable,
  Text,
  InlineStack,
  Scrollable,
  BlockStack,
  ProgressBar,
  Spinner,
  Banner,
} from "@shopify/polaris";

/*
=====================================
SERVER
=====================================
*/

// ✅ React Router mode: return JSON without @remix-run/node
const toJson = (data, init) =>
  Response.json(data, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init,
  });

async function ensureDefinition(admin, key) {
  const check = await admin.graphql(
    `#graphql
    query($key: String!) {
      metafieldDefinitions(
        ownerType: PRODUCT
        first: 1
        namespace: "magento"
        key: $key
      ) {
        nodes { key }
      }
    }`,
    { variables: { key } }
  );

  const json = await check.json();
  const defs = json?.data?.metafieldDefinitions?.nodes ?? [];
  if (defs.find((d) => d.key === key)) return;

  const create = await admin.graphql(
    `#graphql
    mutation Create($input: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $input) {
        userErrors { message }
      }
    }`,
    {
      variables: {
        input: {
          name: `Magento ${key}`,
          namespace: "magento",
          key,
          type: "list.product_reference",
          ownerType: "PRODUCT",
        },
      },
    }
  );

  const createJson = await create.json();
  const errs = createJson?.data?.metafieldDefinitionCreate?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (!intent) {
    return toJson({ success: false, message: "Missing intent" });
  }

  const MAGENTO_BASE = String(await getSettingOr("magento_url", "")).trim();
  if (!MAGENTO_BASE) {
    return toJson({ success: false, message: "Magento URL not configured" });
  }

  /*
  ======================
  FETCH
  ======================
  */
  if (intent === "fetch") {
    try {
      const res = await fetch(
        `${MAGENTO_BASE}/rest/V1/shopify/product-links?page=1&pageSize=5000`
      );

      if (!res.ok) {
        return toJson({
          success: false,
          message: "Failed to fetch Magento links",
        });
      }

      const json = await res.json();
      const rawItems = json?.items ?? [];

      const maps = await prisma.productMapMagento.findMany();
      const mapByMagentoId = new Map(maps.map((m) => [m.magentoProductId, m]));

      const grouped = new Map();

      for (const item of rawItems) {
        const parentId = item.parent_id;
        const linkedId = item.linked_id;

        if (!grouped.has(parentId)) {
          grouped.set(parentId, { related: [], upsell: [], crosssell: [] });
        }

        const group = grouped.get(parentId);
        const linkedMap = mapByMagentoId.get(linkedId);
        if (!linkedMap?.shopifyProductId) continue;

        const entry = {
          shopifyId: linkedMap.shopifyProductId,
          position: item.position ?? 0,
        };

        if (item.link_type === "related") group.related.push(entry);
        if (item.link_type === "upsell") group.upsell.push(entry);
        if (item.link_type === "crosssell") group.crosssell.push(entry);
      }

      const rows = [];

      for (const [parentId, group] of grouped.entries()) {
        const parentMap = mapByMagentoId.get(parentId);
        if (!parentMap?.shopifyProductId) continue;

        const sort = (a, b) => a.position - b.position;

        rows.push({
          parent_id: parentId,
          shopify_id: parentMap.shopifyProductId,
          name: parentMap.name,
          related: group.related.sort(sort).map((x) => x.shopifyId),
          upsell: group.upsell.sort(sort).map((x) => x.shopifyId),
          crosssell: group.crosssell.sort(sort).map((x) => x.shopifyId),
        });
      }

      return toJson({ success: true, items: rows });
    } catch (e) {
      return toJson({ success: false, message: e?.message || String(e) });
    }
  }

  /*
  ======================
  SYNC
  ======================
  */
  if (intent === "sync") {
    try {
      const shopifyProductId = formData.get("shopifyProductId");
      if (!shopifyProductId) {
        return toJson({ success: false, message: "Missing Shopify Product ID" });
      }

      const related = JSON.parse(formData.get("related") || "[]");
      const upsell = JSON.parse(formData.get("upsell") || "[]");
      const crosssell = JSON.parse(formData.get("crosssell") || "[]");

      // --- helper: check product exists ---
      const existsProduct = async (id) => {
        if (!id) return false;
        const res = await admin.graphql(
          `#graphql
          query($id: ID!) {
            product(id: $id) { id }
          }`,
          { variables: { id } }
        );
        const json = await res.json();
        return Boolean(json?.data?.product?.id);
      };

      // ✅ 1) Check sản phẩm chính: không có -> STOP
      const ownerOk = await existsProduct(shopifyProductId);
      if (!ownerOk) {
        return toJson({
          success: false,
          message: `Owner product does not exist: ${shopifyProductId}`,
          stop: true,
        });
      }

      // ✅ 2) Check sản phẩm con: cái nào không có -> remove
      // (chạy tuần tự để đơn giản; nếu list lớn mình sẽ tối ưu batch sau)
      const filterExisting = async (ids) => {
        const out = [];
        for (const id of Array.isArray(ids) ? ids : []) {
          if (await existsProduct(id)) out.push(id);
        }
        return out;
      };

      const relatedOk = await filterExisting(related);
      const upsellOk = await filterExisting(upsell);
      const crosssellOk = await filterExisting(crosssell);

      // ✅ 3) Nếu tất cả con rỗng -> bỏ qua sync (không set metafield)
      const totalChildren =
        relatedOk.length + upsellOk.length + crosssellOk.length;

      if (totalChildren === 0) {
        return toJson({
          success: true,
          skipped: true,
          message: "All linked products missing. Skip metafieldsSet.",
        });
      }

      // ✅ 4) ensure definition
      await ensureDefinition(admin, "related");
      await ensureDefinition(admin, "upsell");
      await ensureDefinition(admin, "crosssell");

      // ✅ 5) Build metafields (chỉ build list còn tồn tại)
      const metafields = [];
      const build = (key, list) => {
        if (!list.length) return;
        metafields.push({
          ownerId: shopifyProductId,
          namespace: "magento",
          key,
          type: "list.product_reference",
          value: JSON.stringify(list),
        });
      };

      build("related", relatedOk);
      build("upsell", upsellOk);
      build("crosssell", crosssellOk);

      const res = await admin.graphql(
        `#graphql
        mutation Set($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors { field message }
          }
        }`,
        { variables: { metafields } }
      );

      const json = await res.json();
      const errs = json?.data?.metafieldsSet?.userErrors ?? [];
      if (errs.length) {
        return toJson({ success: false, message: errs[0].message });
      }

      return toJson({
        success: true,
        skipped: false,
        removed: {
          related: related.length - relatedOk.length,
          upsell: upsell.length - upsellOk.length,
          crosssell: crosssell.length - crosssellOk.length,
        },
      });
    } catch (e) {
      return toJson({ success: false, message: e?.message || String(e) });
    }
  }

  return toJson({ success: false, message: "Invalid intent" });
};

/*
=====================================
CLIENT
=====================================
*/

export default function ProductLinkPage() {
  // ✅ tách 2 fetcher để tránh đụng state/data giữa fetch links và sync
  const fetchLinksFetcher = useFetcher();
  const syncFetcher = useFetcher();
  const shopify = useAppBridge();
  const [items, setItems] = useState([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState(null);
  const [rowLoading, setRowLoading] = useState(null);

  const isFetchingLinks = fetchLinksFetcher.state !== "idle";

  // apply fetch links result
  useEffect(() => {
    if (!fetchLinksFetcher.data) return;

    if (fetchLinksFetcher.data?.items) setItems(fetchLinksFetcher.data.items);
    if (fetchLinksFetcher.data?.success === false)
      setError(fetchLinksFetcher.data.message);
  }, [fetchLinksFetcher.data]);

  // apply sync result (syncOne)
    useEffect(() => {
      if (!syncFetcher.data) return;

      if (syncFetcher.data.success === false) {
        setError(syncFetcher.data.message);
      } else {
        // ✅ toast khi sync thành công
        const { skipped, removed } = syncFetcher.data;

        if (skipped) {
          shopify.toast.show("Skipped: all linked products missing");
        } else {
          const msg =
            removed
              ? `Product synced (removed: r${removed.related}, u${removed.upsell}, c${removed.crosssell})`
              : "Product synced";

          shopify.toast.show(msg);
        }
      }

      setRowLoading(null);
    }, [syncFetcher.data, shopify]);

  const handleFetch = () => {
    setError(null);
    fetchLinksFetcher.submit({ intent: "fetch" }, { method: "POST" });
  };

  const syncOne = (item) => {
    setError(null);
    setRowLoading(item.parent_id);

    const fd = new FormData();
    fd.append("intent", "sync");
    fd.append("shopifyProductId", item.shopify_id);
    fd.append("related", JSON.stringify(item.related));
    fd.append("upsell", JSON.stringify(item.upsell));
    fd.append("crosssell", JSON.stringify(item.crosssell));

    // ✅ dùng fetcher để tránh bị redirect sang login (HTML)
    syncFetcher.submit(fd, { method: "POST" });
  };

  const canSyncAll = useMemo(
    () => Boolean(items.length) && !isSyncing,
    [items.length, isSyncing]
  );

  // ✅ Giữ logic Sync All tuần tự + progress như code gốc
  // Lưu ý: fetch tay có thể vẫn dính login redirect trong embedded app.
  // Nếu muốn chắc chắn 100%: làm intent="syncAll" phía server (1 request).
  const syncAll = async () => {
    setError(null);
    setIsSyncing(true);
    setProgress({ done: 0, total: items.length });

    for (const item of items) {
      const fd = new FormData();
      fd.append("intent", "sync");
      fd.append("shopifyProductId", item.shopify_id);
      fd.append("related", JSON.stringify(item.related));
      fd.append("upsell", JSON.stringify(item.upsell));
      fd.append("crosssell", JSON.stringify(item.crosssell));

      const res = await fetch(window.location.pathname, {
        method: "POST",
        body: fd,
        headers: { Accept: "application/json" },
      });

      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        const text = await res.text();
        console.error("Non-JSON response in syncAll:", {
          status: res.status,
          contentType,
          snippet: text.slice(0, 300),
        });
        setError(
          `Sync All failed: expected JSON but got ${contentType} (status ${res.status}). Likely redirected to login.`
        );
        setIsSyncing(false);
        return;
      }

      const json = await res.json();

      if (!json.success) {
        setError(json.message);
        setIsSyncing(false);
        return;
      }

      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    setIsSyncing(false);
  };

  return (
    <Page title="Sync Product Link">
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}

        <Card>
          <InlineStack gap="200">
            <Button onClick={handleFetch} loading={isFetchingLinks}>
              Fetch Links
            </Button>

            <Button
              variant="primary"
              onClick={syncAll}
              loading={isSyncing}
              disabled={!canSyncAll}
            >
              Sync All
            </Button>
          </InlineStack>

          {isSyncing && (
            <BlockStack gap="200">
              <Text>
                Syncing {progress.done} / {progress.total}
              </Text>
              <ProgressBar progress={(progress.done / progress.total) * 100} />
            </BlockStack>
          )}
        </Card>

        <Card padding="0">
          {isFetchingLinks ? (
            <div style={{ padding: 40, textAlign: "center" }}>
              <Spinner size="large" />
            </div>
          ) : (
            <Scrollable style={{ height: "650px" }}>
              <IndexTable
                itemCount={items.length}
                selectable={false}
                headings={[
                  { title: "Magento ID" },
                  { title: "Shopify ID" },
                  { title: "Product Name" },
                  { title: "Action" },
                ]}
              >
                {items.map((item, index) => (
                  <IndexTable.Row
                    id={String(item.parent_id)}
                    key={item.parent_id}
                    position={index}
                  >
                    <IndexTable.Cell>{item.parent_id}</IndexTable.Cell>
                    <IndexTable.Cell>{item.shopify_id}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <div style={{ whiteSpace: "normal", maxWidth: 300 }}>
                        <Text>{item.name}</Text>
                      </div>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Button
                        size="slim"
                        loading={rowLoading === item.parent_id}
                        onClick={() => syncOne(item)}
                        disabled={isSyncing}
                      >
                        Sync
                      </Button>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Scrollable>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}