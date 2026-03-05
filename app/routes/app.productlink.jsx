import { useFetcher } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
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

async function syncLinksToMetafields({
  admin,
  shopifyProductId,
  related,
  upsell,
  crosssell,
}) {
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
    return {
      success: false,
      message: `Owner product does not exist: ${shopifyProductId}`,
      stop: true,
    };
  }

  // ✅ 2) Check sản phẩm con: cái nào không có -> remove
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
  const totalChildren = relatedOk.length + upsellOk.length + crosssellOk.length;
  if (totalChildren === 0) {
    return {
      success: true,
      skipped: true,
      message: "All linked products missing. Skip metafieldsSet.",
      removed: {
        related: related.length,
        upsell: upsell.length,
        crosssell: crosssell.length,
      },
    };
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
    return { success: false, message: errs[0].message };
  }

  return {
    success: true,
    skipped: false,
    removed: {
      related: related.length - relatedOk.length,
      upsell: upsell.length - upsellOk.length,
      crosssell: crosssell.length - crosssellOk.length,
    },
  };
}

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (!intent) return toJson({ success: false, message: "Missing intent" });

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
  SYNC (single)
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

      const requestId = formData.get("requestId") || null;

      const result = await syncLinksToMetafields({
        admin,
        shopifyProductId,
        related,
        upsell,
        crosssell,
      });

      return toJson({ ...result, requestId });
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
  const fetchLinksFetcher = useFetcher();
  const syncFetcher = useFetcher();
  const shopify = useAppBridge();

  const [items, setItems] = useState([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState(null);
  const [rowLoading, setRowLoading] = useState(null);

  const isFetchingLinks = fetchLinksFetcher.state !== "idle";

  // ---- refs to read latest fetcher state/data inside await loop ----
  const syncStateRef = useRef(syncFetcher.state);
  const syncDataRef = useRef(syncFetcher.data);

  useEffect(() => {
    syncStateRef.current = syncFetcher.state;
  }, [syncFetcher.state]);

  useEffect(() => {
    syncDataRef.current = syncFetcher.data;
  }, [syncFetcher.data]);

  // apply fetch links result
  useEffect(() => {
    if (!fetchLinksFetcher.data) return;

    if (fetchLinksFetcher.data?.success === false) {
      setError(fetchLinksFetcher.data.message);
      return;
    }

    if (fetchLinksFetcher.data?.items) {
      setItems(fetchLinksFetcher.data.items);
      shopify.toast.show(`Fetched ${fetchLinksFetcher.data.items.length} products`);
    }
  }, [fetchLinksFetcher.data, shopify]);

  // show toast for syncOne (manual click)
  // (syncAll will handle its own summary toast to avoid spam)
  const syncModeRef = useRef("idle"); // "idle" | "one" | "all"
  useEffect(() => {
    if (!syncFetcher.data) return;

    // only toast per-item when user clicked Sync (not Sync All)
    if (syncModeRef.current !== "one") return;

    if (syncFetcher.data.success === false) {
      setError(syncFetcher.data.message || "Sync failed");
      setRowLoading(null);
      return;
    }

    const { skipped, removed } = syncFetcher.data;

    if (skipped) {
      shopify.toast.show("Skipped: all linked products missing");
    } else {
      const msg = removed
        ? `Product synced (removed: r${removed.related}, u${removed.upsell}, c${removed.crosssell})`
        : "Product synced";
      shopify.toast.show(msg);
    }

    setRowLoading(null);
    syncModeRef.current = "idle";
  }, [syncFetcher.data, shopify]);

  const handleFetch = () => {
    setError(null);
    fetchLinksFetcher.submit({ intent: "fetch" }, { method: "POST" });
  };

  const syncOne = (item) => {
    setError(null);
    setRowLoading(item.parent_id);
    syncModeRef.current = "one";

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

  // Helper: submit 1 sync request and await its completion (no appFetch)
  const submitSyncAndWait = async (fd, requestId) => {
    fd.append("requestId", requestId);

    // fire
    syncFetcher.submit(fd, { method: "POST" });

    // wait until fetcher back to idle AND response matches requestId
    const startedAt = Date.now();
    const TIMEOUT_MS = 120000; // 2 minutes per item safety

    while (true) {
      // timeout guard
      if (Date.now() - startedAt > TIMEOUT_MS) {
        throw new Error("Timeout waiting for sync response");
      }

      // finish condition
      if (
        syncStateRef.current === "idle" &&
        syncDataRef.current &&
        String(syncDataRef.current.requestId || "") === String(requestId)
      ) {
        return syncDataRef.current;
      }

      // small sleep
      await new Promise((r) => setTimeout(r, 40));
    }
  };

  // ✅ Sync All: chạy từng item bằng syncFetcher, progress nhảy từng item
  const syncAll = async () => {
    setError(null);
    setIsSyncing(true);
    setProgress({ done: 0, total: items.length });
    syncModeRef.current = "all";

    let ok = 0;
    let skippedCount = 0;

    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        setRowLoading(item.parent_id);

        const fd = new FormData();
        fd.append("intent", "sync");
        fd.append("shopifyProductId", item.shopify_id);
        fd.append("related", JSON.stringify(item.related));
        fd.append("upsell", JSON.stringify(item.upsell));
        fd.append("crosssell", JSON.stringify(item.crosssell));

        const requestId = `${Date.now()}-${i}-${item.parent_id}`;

        const result = await submitSyncAndWait(fd, requestId);

        if (!result?.success) {
          setError(result?.message || "Sync failed");
          setIsSyncing(false);
          setRowLoading(null);
          syncModeRef.current = "idle";
          return;
        }

        if (result.skipped) skippedCount += 1;
        else ok += 1;

        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }

      setIsSyncing(false);
      setRowLoading(null);
      syncModeRef.current = "idle";

      if (skippedCount > 0) {
        shopify.toast.show(`Sync All done: ${ok} synced, ${skippedCount} skipped`);
      } else {
        shopify.toast.show(`Sync All done: ${ok} synced`);
      }
    } catch (e) {
      setError(e?.message || String(e));
      setIsSyncing(false);
      setRowLoading(null);
      syncModeRef.current = "idle";
    }
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