// app/routes/app.product.jsx
import { Pagination, TextField } from "@shopify/polaris";
import { useFetcher } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { getSettingOr } from "../utils/settings";
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
} from "@shopify/polaris";

/**
 * ======================
 * HELPERS
 * ======================
 */

function asInt(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function chunk(arr, size = 100) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizePath(value) {
  const raw = asString(value).trim();
  if (!raw) return "";

  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      return new URL(raw).pathname;
    }
  } catch {
    // Keep raw path below.
  }

  return raw.startsWith("/") ? raw : `/${raw}`;
}

function buildProductRedirectFrom(urlKey) {
  const key = asString(urlKey).trim();
  if (!key) return "";

  const path = key.endsWith(".html") ? key : `${key}.html`;
  return normalizePath(path);
}

function buildProductRedirectTo(handle) {
  const h = asString(handle).trim();
  return h ? `/products/${h}` : "";
}

function escapeCsvCell(value) {
  const text = asString(value);
  const doubleQuote = String.fromCharCode(34);
  const lineFeed = String.fromCharCode(10);
  const carriageReturn = String.fromCharCode(13);

  const mustQuote =
    text.includes(doubleQuote) ||
    text.includes(",") ||
    text.includes(lineFeed) ||
    text.includes(carriageReturn);

  if (mustQuote) {
    return doubleQuote + text.split(doubleQuote).join(doubleQuote + doubleQuote) + doubleQuote;
  }

  return text;
}

function downloadRedirectCsv(items) {
  if (typeof window === "undefined") return;

  const rows = items
    .filter((item) => item.redirectFrom && item.redirectTo)
    .map((item) => [item.redirectFrom, item.redirectTo]);

  const newline = String.fromCharCode(10);
  const csv = [["Redirect from", "Redirect to"], ...rows]
    .map((row) => row.map(escapeCsvCell).join(","))
    .join(newline);

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "shopify-product-redirects.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

/**
 * ======================
 * SHOPIFY HELPERS
 * ======================
 */

async function getFirstLocationId(admin) {
  const res = await admin.graphql(
    `#graphql
    query {
      locations(first: 5) {
        nodes { id name }
      }
    }`
  );

  const json = await res.json();
  const loc = json?.data?.locations?.nodes?.[0];
  if (!loc?.id) throw new Error("No location found");
  return loc.id;
}

async function getShopifyProductHandles(admin, productIds) {
  const uniqueIds = [...new Set(productIds.filter(Boolean))];
  const handleMap = new Map();

  for (const ids of chunk(uniqueIds, 100)) {
    const res = await admin.graphql(
      `#graphql
      query GetProducts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            handle
          }
        }
      }`,
      { variables: { ids } }
    );

    const json = await res.json();
    const nodes = json?.data?.nodes ?? [];

    for (const node of nodes) {
      if (node?.id && node?.handle) {
        handleMap.set(node.id, node.handle);
      }
    }
  }

  return handleMap;
}

async function getProductFirstVariant(admin, productId) {
  const res = await admin.graphql(
    `#graphql
    query GetProductVariant($id: ID!) {
      product(id: $id) {
        id
        handle
        variants(first: 1) {
          nodes {
            id
            inventoryItem { id }
          }
        }
      }
    }`,
    { variables: { id: productId } }
  );

  const json = await res.json();
  const product = json?.data?.product;
  const variant = product?.variants?.nodes?.[0];

  if (!product?.id || !variant?.id || !variant?.inventoryItem?.id) {
    throw new Error("Missing product variant or inventory item");
  }

  return {
    productId: product.id,
    handle: product.handle,
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem.id,
  };
}

async function createProductMinimal(admin, { title }) {
  const res = await admin.graphql(
    `#graphql
    mutation CreateProduct($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          handle
          variants(first: 1) {
            nodes {
              id
              inventoryItem { id }
            }
          }
        }
        userErrors { message }
      }
    }`,
    {
      variables: {
        input: {
          title,
        },
      },
    }
  );

  const json = await res.json();
  const payload = json?.data?.productCreate;
  const errs = payload?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);

  const product = payload?.product;
  const variant = product?.variants?.nodes?.[0];

  if (!product?.id || !variant?.id || !variant?.inventoryItem?.id) {
    throw new Error("productCreate: missing product/variant/inventoryItem id");
  }

  return {
    productId: product.id,
    handle: product.handle,
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem.id,
    created: true,
  };
}

async function updateVariantPrice(admin, { productId, variantId, price }) {
  const res = await admin.graphql(
    `#graphql
    mutation UpdateVariantPrice(
      $productId: ID!
      $variants: [ProductVariantsBulkInput!]!
    ) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { message }
      }
    }`,
    {
      variables: {
        productId,
        variants: [
          {
            id: variantId,
            price: asString(price || "0"),
          },
        ],
      },
    }
  );

  const json = await res.json();
  const errs = json?.data?.productVariantsBulkUpdate?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);
}

async function updateInventoryItemSku(admin, { inventoryItemId, sku }) {
  if (!sku) return;

  const res = await admin.graphql(
    `#graphql
    mutation UpdateInventoryItemSku($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem { id sku }
        userErrors { message }
      }
    }`,
    {
      variables: {
        id: inventoryItemId,
        input: { sku },
      },
    }
  );

  const json = await res.json();
  const errs = json?.data?.inventoryItemUpdate?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);
}

async function setInventoryTracked(admin, { inventoryItemId, tracked = true }) {
  const res = await admin.graphql(
    `#graphql
    mutation SetTracked($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem { id tracked }
        userErrors { message }
      }
    }`,
    {
      variables: {
        id: inventoryItemId,
        input: { tracked },
      },
    }
  );

  const json = await res.json();
  const errs = json?.data?.inventoryItemUpdate?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);
}

async function activateInventoryItem(admin, { inventoryItemId, locationId }) {
  const res = await admin.graphql(
    `#graphql
    mutation ActivateInventory($inventoryItemId: ID!, $locationId: ID!) {
      inventoryActivate(
        inventoryItemId: $inventoryItemId
        locationId: $locationId
      ) {
        userErrors { message }
      }
    }`,
    {
      variables: {
        inventoryItemId,
        locationId,
      },
    }
  );

  const json = await res.json();
  const errs = json?.data?.inventoryActivate?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);
}

async function setInventoryOnHand(admin, { inventoryItemId, locationId, quantity }) {
  const res = await admin.graphql(
    `#graphql
    mutation SetOnHand($input: InventorySetOnHandQuantitiesInput!) {
      inventorySetOnHandQuantities(input: $input) {
        userErrors { message }
      }
    }`,
    {
      variables: {
        input: {
          reason: "correction",
          setQuantities: [
            {
              inventoryItemId,
              locationId,
              quantity: Number(quantity) || 0,
            },
          ],
        },
      },
    }
  );

  const json = await res.json();
  const errs = json?.data?.inventorySetOnHandQuantities?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);
}

async function syncProductPriceStock(admin, { productId, title, sku, price, qty }) {
  let base;

  if (productId) {
    base = await getProductFirstVariant(admin, productId);
    base.created = false;
  } else {
    base = await createProductMinimal(admin, { title });
  }

  await updateVariantPrice(admin, {
    productId: base.productId,
    variantId: base.variantId,
    price,
  });

  await updateInventoryItemSku(admin, {
    inventoryItemId: base.inventoryItemId,
    sku,
  });

  const locationId = await getFirstLocationId(admin);

  await setInventoryTracked(admin, {
    inventoryItemId: base.inventoryItemId,
    tracked: true,
  });

  await activateInventoryItem(admin, {
    inventoryItemId: base.inventoryItemId,
    locationId,
  });

  await setInventoryOnHand(admin, {
    inventoryItemId: base.inventoryItemId,
    locationId,
    quantity: qty,
  });

  return base;
}

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
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  const intentsNeedMagento = new Set(["fetch", "sync", "resync", "sync_product_urls"]);
  let MAGENTO_BASE = null;

  if (intentsNeedMagento.has(intent)) {
    MAGENTO_BASE = String(await getSettingOr("magento_url", "")).trim();

    if (!MAGENTO_BASE) {
      return {
        success: false,
        error: "PLEASE_SETUP_MAGENTO_URL",
        message: "Please setup url",
      };
    }
  }

  /**
   * FETCH MAGENTO PRODUCTS
   */
  if (intent === "fetch") {
    const page = Number(formData.get("page")) || 1;
    const pageSize = Number(formData.get("page_size")) || 1000;
    const productId = String(formData.get("product_id") ?? "").trim();

    const url = new URL(`${MAGENTO_BASE}/rest/V1/shopify/products`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(pageSize));
    if (productId) url.searchParams.set("product_id", productId);

    const res = await fetch(url.toString());

    if (!res.ok) {
      throw new Response("Failed to fetch Magento products", { status: 500 });
    }

    const magento = await res.json();
    const mapped = await prisma.productMapMagento.findMany();
    const mappedByMagentoId = new Map(
      mapped.map((m) => [Number(m.magentoProductId), m])
    );

    const handleMap = await getShopifyProductHandles(
      admin,
      mapped.map((m) => m.shopifyProductId)
    );

    const items = (magento.items ?? []).map((p) => {
      const map = mappedByMagentoId.get(Number(p.product_id));
      const shopifyHandle = map?.shopifyProductId
        ? handleMap.get(map.shopifyProductId)
        : "";

      return {
        magentoProductId: p.product_id,
        name: p.name,
        sku: p.sku,
        price: p.special_price ?? p.price,
        qty: p.salable_qty ?? p.qty ?? 0,
        urlKey: p.url_key,

        shopifyProductId: map?.shopifyProductId ?? null,
        isSynced: Boolean(map),

        redirectFrom: map?.redirectFrom ?? buildProductRedirectFrom(p.url_key),
        redirectTo: map?.redirectTo ?? buildProductRedirectTo(shopifyHandle),
      };
    });

    return {
      items,
      page: magento.page ?? page,
      page_size: magento.page_size ?? pageSize,
      total: magento.total ?? 0,
      total_page: magento.total_page ?? 1,
    };
  }

  /**
   * SYNC PRODUCT URLS TO DATABASE
   */
  if (intent === "sync_product_urls") {
    const page = Number(formData.get("page")) || 1;
    const pageSize = Number(formData.get("page_size")) || 1000;

    const url = new URL(`${MAGENTO_BASE}/rest/V1/shopify/products`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(pageSize));

    const res = await fetch(url.toString());

    if (!res.ok) {
      throw new Response("Failed to fetch Magento products", { status: 500 });
    }

    const magento = await res.json();
    const magentoById = new Map(
      (magento.items ?? []).map((p) => [Number(p.product_id), p])
    );

    const mapped = await prisma.productMapMagento.findMany({
      select: {
        magentoProductId: true,
        shopifyProductId: true,
      },
    });

    const handleMap = await getShopifyProductHandles(
      admin,
      mapped.map((m) => m.shopifyProductId)
    );

    let updated = 0;
    let skipped = 0;

    for (const map of mapped) {
      const magentoProduct = magentoById.get(Number(map.magentoProductId));
      const shopifyHandle = handleMap.get(map.shopifyProductId);

      const redirectFrom = buildProductRedirectFrom(magentoProduct?.url_key);
      const redirectTo = buildProductRedirectTo(shopifyHandle);

      if (!redirectFrom || !redirectTo) {
        skipped += 1;
        continue;
      }

      await prisma.productMapMagento.update({
        where: { magentoProductId: map.magentoProductId },
        data: {
          redirectFrom,
          redirectTo,
        },
      });

      updated += 1;
    }

    return { success: true, updated, skipped };
  }

  /**
   * SYNC / RESYNC PRODUCT
   * Chỉ update price + stock qty + URL fields.
   */
  if (intent === "sync" || intent === "resync") {
    const magentoProductId = asInt(formData.get("magentoProductId"));
    const name = asString(formData.get("name"));
    const sku = asString(formData.get("sku"));
    const price = asString(formData.get("price"));
    const qty = asInt(formData.get("qty"), 0);
    const redirectFrom = normalizePath(formData.get("redirectFrom"));
    const redirectToFromForm = normalizePath(formData.get("redirectTo"));

    if (!magentoProductId || !name) {
      throw new Response("Missing required fields", { status: 400 });
    }

    const existing = await prisma.productMapMagento.findUnique({
      where: { magentoProductId },
    });

    if (intent === "resync" && !existing?.shopifyProductId) {
      throw new Error("This product is not synced yet");
    }

    const base = await syncProductPriceStock(admin, {
      productId: existing?.shopifyProductId ?? null,
      title: name,
      sku,
      price,
      qty,
    });

    const redirectTo = redirectToFromForm || buildProductRedirectTo(base.handle);

    await prisma.productMapMagento.upsert({
      where: { magentoProductId },
      create: {
        magentoProductId,
        shopifyProductId: base.productId,
        sku: sku || null,
        name,
        redirectFrom,
        redirectTo,
      },
      update: {
        shopifyProductId: base.productId,
        sku: sku || null,
        name,
        redirectFrom,
        redirectTo,
      },
    });

    return {
      success: true,
      intent,
      magentoProductId,
      shopifyProductId: base.productId,
      created: base.created,
    };
  }

  throw new Response("Invalid intent", { status: 400 });
};

/**
 * ======================
 * CLIENT
 * ======================
 */

function RowActions({ item, onDone, disabled, shopify }) {
  const syncFetcher = useFetcher();
  const resyncFetcher = useFetcher();

  const syncing = syncFetcher.state === "loading" || syncFetcher.state === "submitting";
  const resyncing =
    resyncFetcher.state === "loading" || resyncFetcher.state === "submitting";

  useEffect(() => {
    if (syncFetcher.state === "idle" && syncFetcher.data?.success) {
      shopify.toast.show("Product synced");
      onDone();
    }
  }, [syncFetcher.state, syncFetcher.data, shopify, onDone]);

  useEffect(() => {
    if (resyncFetcher.state === "idle" && resyncFetcher.data?.success) {
      shopify.toast.show("Product re-synced");
      onDone();
    }
  }, [resyncFetcher.state, resyncFetcher.data, shopify, onDone]);

  const HiddenFields = () => (
    <>
      <input type="hidden" name="magentoProductId" value={item.magentoProductId} />
      <input type="hidden" name="name" value={item.name} />
      <input type="hidden" name="sku" value={asString(item.sku)} />
      <input type="hidden" name="price" value={asString(item.price)} />
      <input type="hidden" name="qty" value={asString(item.qty)} />
      <input type="hidden" name="redirectFrom" value={asString(item.redirectFrom)} />
      <input type="hidden" name="redirectTo" value={asString(item.redirectTo)} />
    </>
  );

  return (
    <InlineStack gap="200">
      <syncFetcher.Form method="post">
        <input type="hidden" name="intent" value="sync" />
        <HiddenFields />
        <Button
          size="slim"
          submit
          loading={syncing}
          disabled={disabled || item.isSynced || resyncing || syncing}
        >
          Sync
        </Button>
      </syncFetcher.Form>

      <resyncFetcher.Form method="post">
        <input type="hidden" name="intent" value="resync" />
        <HiddenFields />
        <Button
          size="slim"
          submit
          variant="secondary"
          loading={resyncing}
          disabled={disabled || !item.isSynced || syncing || resyncing}
        >
          Re-sync
        </Button>
      </resyncFetcher.Form>
    </InlineStack>
  );
}

export default function ProductPage() {
  const fetcher = useFetcher();
  const syncUrlsFetcher = useFetcher();
  const shopify = useAppBridge();

  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [searchId, setSearchId] = useState("");
  const [isBulkSyncing, setIsBulkSyncing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [pageInputFocusValue, setPageInputFocusValue] = useState("");

  const items = fetcher.data?.items ?? [];
  const unsyncedItems = items.filter((i) => !i.isSynced);
  const syncedItems = items.filter((i) => i.isSynced);
  const allSynced = unsyncedItems.length === 0;
  const allResynced = syncedItems.length === 0;
  const syncingUrls = syncUrlsFetcher.state !== "idle";

  const pageInfo = fetcher.data
    ? {
        page: fetcher.data.page ?? 1,
        totalPage: fetcher.data.total_page ?? 1,
        total: fetcher.data.total ?? 0,
        pageSize: fetcher.data.page_size ?? 1000,
      }
    : { page: 1, totalPage: 1, total: 0, pageSize: 1000 };

  const handleFetch = (nextPage = page, nextProductId = searchId) => {
    let targetPage = nextPage;

    if (String(nextProductId || "").trim().length > 0) {
      targetPage = 1;
    }

    setPage(targetPage);
    fetcher.submit(
      {
        intent: "fetch",
        page: String(targetPage),
        page_size: "1000",
        product_id: String(nextProductId || "").trim(),
      },
      { method: "POST" }
    );
  };

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.page != null) {
      setPage(fetcher.data.page);
      setPageInput(String(fetcher.data.page));
    }
  }, [fetcher.state, fetcher.data?.page]);

  useEffect(() => {
    const t = setTimeout(() => handleFetch(1), 200);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (syncUrlsFetcher.state === "idle" && syncUrlsFetcher.data?.success) {
      const updated = Number(syncUrlsFetcher.data?.updated || 0);
      const skipped = Number(syncUrlsFetcher.data?.skipped || 0);
      shopify.toast.show(`Synced product URLs: ${updated} updated, ${skipped} skipped`);
      handleFetch(page);
    }
  }, [syncUrlsFetcher.state]);

  const syncProductUrls = () => {
    syncUrlsFetcher.submit(
      {
        intent: "sync_product_urls",
        page: String(pageInfo.page || page),
        page_size: String(pageInfo.pageSize || 1000),
      },
      { method: "POST" }
    );
  };

  const handleExportRedirectCsv = () => {
    downloadRedirectCsv(items);
    shopify.toast.show("Product redirect CSV exported");
  };

  const submitBulkProduct = async (item, intentName) => {
    const fd = new FormData();
    fd.append("intent", intentName);
    fd.append("magentoProductId", item.magentoProductId);
    fd.append("name", item.name);
    fd.append("sku", item.sku || "");
    fd.append("price", item.price || "");
    fd.append("qty", item.qty ?? 0);
    fd.append("redirectFrom", item.redirectFrom || "");
    fd.append("redirectTo", item.redirectTo || "");

    await fetch(window.location.pathname, {
      method: "POST",
      body: fd,
    });
  };

  const resyncAll = async () => {
    if (syncedItems.length === 0) return;

    setIsBulkSyncing(true);
    setProgress({ done: 0, total: syncedItems.length });

    for (const item of syncedItems) {
      await submitBulkProduct(item, "resync");
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    setIsBulkSyncing(false);
    handleFetch(page);
    shopify.toast.show("All synced products updated");
  };

  const syncAll = async () => {
    if (unsyncedItems.length === 0) return;

    setIsBulkSyncing(true);
    setProgress({ done: 0, total: unsyncedItems.length });

    for (const item of unsyncedItems) {
      await submitBulkProduct(item, "sync");
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    setIsBulkSyncing(false);
    handleFetch(page);
    shopify.toast.show("All products synced");
  };

  const normalizePage = (raw) => {
    const total = pageInfo.totalPage || 1;
    const s = String(raw ?? "").trim();
    const n = Number(s);

    if (!s) return null;
    if (!Number.isFinite(n)) return null;

    return Math.max(1, Math.min(total, Math.trunc(n)));
  };

  const goToPage = (raw) => {
    const p = normalizePage(raw);

    if (p == null) {
      setPageInput(String(pageInfo.page ?? 1));
      return;
    }

    const current = Number(pageInfo.page ?? 1);
    if (p === current) {
      setPageInput(String(current));
      return;
    }

    setPageInput(String(p));
    handleFetch(p);
  };

  return (
    <Page title="Magento → Shopify Products">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <div style={{ width: 260 }}>
                <TextField
                  labelHidden
                  label="product id"
                  placeholder="product id"
                  value={searchId}
                  onChange={(v) => setSearchId(v)}
                  autoComplete="off"
                />
              </div>

              <InlineStack gap="200">
                <Button
                  onClick={() => handleFetch(page)}
                  loading={fetcher.state !== "idle"}
                  disabled={isBulkSyncing || syncingUrls}
                >
                  Fetch products
                </Button>

                <Button
                  variant="primary"
                  onClick={syncAll}
                  loading={isBulkSyncing}
                  disabled={allSynced || isBulkSyncing || syncingUrls}
                >
                  Sync all
                </Button>

                <Button
                  variant="secondary"
                  onClick={resyncAll}
                  loading={isBulkSyncing}
                  disabled={allResynced || isBulkSyncing || syncingUrls}
                >
                  Re-sync all
                </Button>
              </InlineStack>
            </InlineStack>

            <InlineStack gap="200">
              <Button
                variant="secondary"
                onClick={syncProductUrls}
                loading={syncingUrls}
                disabled={items.length === 0 || isBulkSyncing || syncingUrls}
              >
                Sync product URLs
              </Button>

              <Button
                variant="secondary"
                onClick={handleExportRedirectCsv}
                disabled={items.length === 0 || isBulkSyncing || syncingUrls}
              >
                Export CSV
              </Button>
            </InlineStack>

            {isBulkSyncing && (
              <BlockStack gap="200">
                <Text>
                  Syncing {progress.done} / {progress.total}
                </Text>
                <ProgressBar progress={(progress.done / progress.total) * 100} />
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        {fetcher.data?.total_page > 1 && (
          <Card>
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="200" blockAlign="center">
                <Text>Page</Text>

                <div style={{ width: 90 }}>
                  <TextField
                    labelHidden
                    label="page"
                    value={pageInput}
                    onChange={setPageInput}
                    autoComplete="off"
                    onFocus={() => setPageInputFocusValue(pageInput)}
                    onBlur={() => {
                      if (pageInput === pageInputFocusValue) return;
                      goToPage(pageInput);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        goToPage(pageInput);
                        e.currentTarget.blur();
                      }
                    }}
                  />
                </div>

                <Text>
                  / {pageInfo.totalPage} — Total {pageInfo.total} items
                </Text>
              </InlineStack>

              <Pagination
                hasPrevious={pageInfo.page > 1}
                onPrevious={() => handleFetch(pageInfo.page - 1)}
                hasNext={pageInfo.page < pageInfo.totalPage}
                onNext={() => handleFetch(pageInfo.page + 1)}
              />
            </InlineStack>
          </Card>
        )}

        {items.length > 0 && (
          <Card padding="0">
            <Scrollable style={{ height: "600px" }}>
              <IndexTable
                itemCount={items.length}
                stickyHeader
                selectable={false}
                headings={[
                  { title: "Shopify Product ID" },
                  { title: "Magento Product ID" },
                  { title: "Name" },
                  { title: "Price" },
                  { title: "Qty" },
                  { title: "Redirect from" },
                  { title: "Redirect to" },
                  { title: "Action" },
                ]}
              >
                {items.map((item, index) => (
                  <IndexTable.Row
                    id={String(item.magentoProductId)}
                    key={item.magentoProductId}
                    position={index}
                  >
                    <IndexTable.Cell>{item.shopifyProductId || "-"}</IndexTable.Cell>
                    <IndexTable.Cell>{item.magentoProductId}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <div style={{ whiteSpace: "normal", maxWidth: "300px" }}>
                        <Text>{item.name}</Text>
                      </div>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{item.price ?? "-"}</IndexTable.Cell>
                    <IndexTable.Cell>{item.qty ?? "-"}</IndexTable.Cell>
                    <IndexTable.Cell>{item.redirectFrom || "-"}</IndexTable.Cell>
                    <IndexTable.Cell>{item.redirectTo || "-"}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <RowActions
                        item={item}
                        onDone={() => handleFetch(page)}
                        disabled={isBulkSyncing || syncingUrls}
                        shopify={shopify}
                      />
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Scrollable>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
