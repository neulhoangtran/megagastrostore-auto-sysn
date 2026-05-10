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
  Scrollable,
  BlockStack,
  ProgressBar,
} from "@shopify/polaris";

/**
 * ======================
 * HELPERS
 * ======================
 */

function chunk(arr, size = 250) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function asInt(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
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

function buildCollectionRedirectFrom(urlPath) {
  return normalizePath(urlPath);
}

function buildCollectionRedirectTo(handle) {
  const h = asString(handle).trim();
  return h ? `/collections/${h}` : "";
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
  link.download = "shopify-category-redirects.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

// Magento image helpers
const MAGENTO_BASE_URL = "https://megagas.site";

function buildMagentoImageUrl(imagePath) {
  if (!imagePath) return null;
  if (imagePath.startsWith("http")) return imagePath;
  return `${MAGENTO_BASE_URL}${imagePath}`;
}

async function addProductsToCollection(admin, { collectionId, productIds }) {
  const res = await admin.graphql(
    `#graphql
    mutation AddProducts($id: ID!, $productIds: [ID!]!) {
      collectionAddProductsV2(id: $id, productIds: $productIds) {
        job { id done }
        userErrors { field message }
      }
    }`,
    { variables: { id: collectionId, productIds } }
  );

  const json = await res.json();
  const payload = json?.data?.collectionAddProductsV2;
  const errs = payload?.userErrors ?? [];

  if (errs.length) throw new Error(errs[0].message);

  return payload?.job ?? null;
}

async function getShopifyCollectionHandles(admin, collectionIds) {
  const uniqueIds = [...new Set(collectionIds.filter(Boolean))];
  const handleMap = new Map();

  for (const ids of chunk(uniqueIds, 100)) {
    const res = await admin.graphql(
      `#graphql
      query GetCollections($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Collection {
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

/**
 * ======================
 * SHOPIFY HELPERS
 * ======================
 */

async function getOnlineStorePublicationId(admin) {
  const res = await admin.graphql(
    `#graphql
    query {
      publications(first: 20) {
        nodes {
          id
          name
        }
      }
    }`
  );

  const json = await res.json();
  const pubs = json?.data?.publications?.nodes ?? [];

  const onlineStore = pubs.find((p) => p.name === "Online Store");
  if (!onlineStore) {
    throw new Error("Online Store publication not found");
  }

  return onlineStore.id;
}

async function publishCollection(admin, collectionId) {
  const publicationId = await getOnlineStorePublicationId(admin);

  const res = await admin.graphql(
    `#graphql
    mutation PublishCollection($id: ID!, $publicationId: ID!) {
      publishablePublish(
        id: $id
        input: { publicationId: $publicationId }
      ) {
        userErrors {
          message
        }
      }
    }`,
    {
      variables: {
        id: collectionId,
        publicationId,
      },
    }
  );

  const json = await res.json();
  const errors = json?.data?.publishablePublish?.userErrors ?? [];

  if (errors.length > 0) {
    throw new Error(errors[0].message);
  }
}

async function createShopifyUrlRedirect(admin, { path, target }) {
  const res = await admin.graphql(
    `#graphql
    mutation CreateUrlRedirect($urlRedirect: UrlRedirectInput!) {
      urlRedirectCreate(urlRedirect: $urlRedirect) {
        urlRedirect {
          id
          path
          target
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        urlRedirect: {
          path,
          target,
        },
      },
    }
  );

  const json = await res.json();
  const payload = json?.data?.urlRedirectCreate;
  const errors = payload?.userErrors ?? [];

  if (errors.length > 0) {
    throw new Error(errors[0].message);
  }

  return payload?.urlRedirect ?? null;
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

  const intentsNeedMagento = new Set([
    "fetch",
    "sync",
    "resync",
    "sync_products",
    "sync_category_redirects",
  ]);

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
   * FETCH MAGENTO CATEGORIES
   */
  if (intent === "fetch") {
    const res = await fetch(`${MAGENTO_BASE}/rest/V1/shopify/categories`);

    if (!res.ok) {
      throw new Response("Failed to fetch Magento categories", { status: 500 });
    }

    const magentoData = await res.json();
    const mapped = await prisma.collectionMapCategory.findMany();

    const mappedByMagentoId = new Map(
      mapped.map((m) => [m.magentoCategoryId, m])
    );

    const items = (magentoData?.items ?? []).map((cat) => {
      const map = mappedByMagentoId.get(Number(cat.category_id));

      return {
        magentoCategoryId: cat.category_id,
        name: cat.name,
        shopifyCollectionId: map?.collectionId ?? null,
        isSynced: Boolean(map),

        redirectFrom: map?.redirectFrom ?? buildCollectionRedirectFrom(cat.url_path),
        redirectTo: map?.redirectTo ?? "",

        image: cat.image,
        urlPath: cat.url_path,
        metaTitle: cat.meta_title,
        metaDescription: cat.meta_description,
        description: cat.description,
      };
    });

    return { items };
  }

  /**
   * SYNC CATEGORY REDIRECT PATHS TO DATABASE
   */
  if (intent === "sync_category_redirects") {
    const res = await fetch(`${MAGENTO_BASE}/rest/V1/shopify/categories`);

    if (!res.ok) {
      throw new Response("Failed to fetch Magento categories", { status: 500 });
    }

    const magentoData = await res.json();
    const magentoItems = magentoData?.items ?? [];

    const magentoById = new Map(
      magentoItems.map((cat) => [Number(cat.category_id), cat])
    );

    const mapped = await prisma.collectionMapCategory.findMany({
      select: {
        collectionId: true,
        magentoCategoryId: true,
      },
    });

    const handleMap = await getShopifyCollectionHandles(
      admin,
      mapped.map((m) => m.collectionId)
    );

    let updated = 0;
    let skipped = 0;

    for (const map of mapped) {
      const magentoCat = magentoById.get(Number(map.magentoCategoryId));
      const handle = handleMap.get(map.collectionId);

      const redirectFrom = buildCollectionRedirectFrom(magentoCat?.url_path);
      const redirectTo = buildCollectionRedirectTo(handle);

      if (!redirectFrom || !redirectTo) {
        skipped += 1;
        continue;
      }

      await prisma.collectionMapCategory.update({
        where: { collectionId: map.collectionId },
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
   * PUSH CATEGORY REDIRECTS TO SHOPIFY URL REDIRECTS
   */
  if (intent === "push_shopify_category_redirects") {
    const rows = await prisma.collectionMapCategory.findMany({
      where: {
        redirectFrom: { not: null },
        redirectTo: { not: null },
      },
      select: {
        id: true,
        redirectFrom: true,
        redirectTo: true,
      },
    });

    let created = 0;
    let failed = 0;
    const errors = [];

    for (const row of rows) {
      const path = normalizePath(row.redirectFrom);
      const target = normalizePath(row.redirectTo);

      if (!path || !target || path === target) {
        continue;
      }

      try {
        await createShopifyUrlRedirect(admin, { path, target });
        created += 1;
      } catch (error) {
        failed += 1;
        errors.push({
          id: row.id,
          path,
          target,
          message: error?.message || "Unknown error",
        });
      }
    }

    return {
      success: true,
      total: rows.length,
      created,
      failed,
      errors: errors.slice(0, 10),
    };
  }

  /**
   * SYNC PRODUCTS TO COLLECTION
   */
  if (intent === "sync_products") {
    const magentoCategoryId = asInt(formData.get("magentoCategoryId"));
    const collectionId = asString(formData.get("collectionId"));

    if (!magentoCategoryId || !collectionId) {
      throw new Response("Missing magentoCategoryId/collectionId", { status: 400 });
    }

    const res = await fetch(`${MAGENTO_BASE}/rest/V1/shopify/category-products`);

    if (!res.ok) {
      throw new Response("Failed to fetch category-products", { status: 500 });
    }

    const data = await res.json();
    const items = data?.items ?? [];

    const row = items.find(
      (x) => Number(x.category_id) === Number(magentoCategoryId)
    );

    if (!row) {
      return { success: true, added: 0, reason: "No products in this category" };
    }

    const magentoProductIds = (() => {
      try {
        const a = JSON.parse(row.product_ids_json || "[]");
        return Array.isArray(a) ? a.map(Number).filter(Number.isFinite) : [];
      } catch {
        return [];
      }
    })();

    if (!magentoProductIds.length) {
      return { success: true, added: 0, reason: "Empty product list" };
    }

    const mappedProducts = await prisma.productMapMagento.findMany({
      where: { magentoProductId: { in: magentoProductIds } },
      select: { magentoProductId: true, shopifyProductId: true },
    });

    const shopifyProductIds = mappedProducts
      .map((p) => p.shopifyProductId)
      .filter(Boolean);

    if (!shopifyProductIds.length) {
      return { success: true, added: 0, reason: "No synced products yet" };
    }

    const chunks = chunk(shopifyProductIds, 250);
    const jobs = [];

    for (const ids of chunks) {
      const job = await addProductsToCollection(admin, {
        collectionId,
        productIds: ids,
      });

      if (job?.id) jobs.push(job);
    }

    return {
      success: true,
      added: shopifyProductIds.length,
      totalInCategory: magentoProductIds.length,
      syncedInDb: shopifyProductIds.length,
      jobs,
    };
  }

  /**
   * SYNC / RESYNC CATEGORY
   */
  if (intent === "sync" || intent === "resync") {
    const magentoCategoryId = asInt(formData.get("magentoCategoryId"));
    const name = asString(formData.get("name"));

    const metaTitle = asString(formData.get("metaTitle"));
    const metaDescription = asString(formData.get("metaDescription"));
    const description = asString(formData.get("description"));

    const imagePath = asString(formData.get("image"));
    const imageSrc = buildMagentoImageUrl(imagePath);

    const redirectFrom = normalizePath(formData.get("redirectFrom"));
    const redirectToFromForm = normalizePath(formData.get("redirectTo"));

    if (!magentoCategoryId || !name) {
      throw new Response("Missing required fields", { status: 400 });
    }

    const input = {
      title: name,
      descriptionHtml: description || metaDescription || "",
      seo: {
        title: metaTitle || name,
        description: metaDescription || "",
      },
      ...(imageSrc ? { image: { src: imageSrc } } : {}),
    };

    if (intent === "sync") {
      const res = await admin.graphql(
        `#graphql
        mutation CreateCollection($input: CollectionInput!) {
          collectionCreate(input: $input) {
            collection { id handle }
            userErrors { message }
          }
        }`,
        { variables: { input } }
      );

      const json = await res.json();
      const payload = json.data.collectionCreate;

      if (payload.userErrors?.length) {
        throw new Error(payload.userErrors[0].message);
      }

      const collectionId = payload.collection.id;
      const collectionHandle = payload.collection.handle;
      const redirectTo = redirectToFromForm || buildCollectionRedirectTo(collectionHandle);

      await publishCollection(admin, collectionId);

      await prisma.collectionMapCategory.create({
        data: {
          magentoCategoryId,
          name,
          collectionId,
          redirectFrom,
          redirectTo,
        },
      });

      return { success: true };
    }

    const collectionId = asString(formData.get("collectionId"));

    if (!collectionId) {
      throw new Response("Missing collectionId", { status: 400 });
    }

    const res = await admin.graphql(
      `#graphql
      mutation UpdateCollection($input: CollectionInput!) {
        collectionUpdate(input: $input) {
          collection { id handle }
          userErrors { message }
        }
      }`,
      {
        variables: {
          input: { id: collectionId, ...input },
        },
      }
    );

    const json = await res.json();
    const payload = json.data.collectionUpdate;

    if (payload.userErrors?.length) {
      throw new Error(payload.userErrors[0].message);
    }

    const collectionHandle = payload.collection?.handle;
    const redirectTo = redirectToFromForm || buildCollectionRedirectTo(collectionHandle);

    await publishCollection(admin, collectionId);

    await prisma.collectionMapCategory.update({
      where: { collectionId },
      data: {
        name,
        redirectFrom,
        redirectTo,
      },
    });

    return { success: true };
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
  const syncProductsFetcher = useFetcher();

  const syncing = syncFetcher.state === "loading" || syncFetcher.state === "submitting";
  const resyncing =
    resyncFetcher.state === "loading" || resyncFetcher.state === "submitting";
  const syncingProducts = syncProductsFetcher.state !== "idle";

  useEffect(() => {
    if (syncProductsFetcher.state === "idle" && syncProductsFetcher.data?.success) {
      const added = Number(syncProductsFetcher.data?.added || 0);
      shopify.toast.show(`Synced ${added} products to collection`);
      onDone();
    }
  }, [syncProductsFetcher.state]);

  useEffect(() => {
    if (syncFetcher.state === "idle" && syncFetcher.data?.success) {
      shopify.toast.show("Category synced");
      onDone();
    }
  }, [syncFetcher.state]);

  useEffect(() => {
    if (resyncFetcher.state === "idle" && resyncFetcher.data?.success) {
      shopify.toast.show("Category re-synced");
      onDone();
    }
  }, [resyncFetcher.state]);

  const HiddenFields = () => (
    <>
      <input type="hidden" name="magentoCategoryId" value={item.magentoCategoryId} />
      <input type="hidden" name="name" value={item.name} />
      <input type="hidden" name="image" value={asString(item.image)} />
      <input type="hidden" name="metaTitle" value={asString(item.metaTitle)} />
      <input type="hidden" name="metaDescription" value={asString(item.metaDescription)} />
      <input type="hidden" name="description" value={asString(item.description)} />
      <input type="hidden" name="redirectFrom" value={asString(item.redirectFrom)} />
      <input type="hidden" name="redirectTo" value={asString(item.redirectTo)} />
    </>
  );

  return (
    <InlineStack gap="200" wrap={false}>
      <syncFetcher.Form method="post">
        <input type="hidden" name="intent" value="sync" />
        <HiddenFields />
        <Button
          size="slim"
          submit
          loading={syncing}
          disabled={disabled || item.isSynced || resyncing}
        >
          Sync
        </Button>
      </syncFetcher.Form>

      <resyncFetcher.Form method="post">
        <input type="hidden" name="intent" value="resync" />
        <input type="hidden" name="collectionId" value={item.shopifyCollectionId || ""} />
        <HiddenFields />
        <Button
          size="slim"
          submit
          variant="secondary"
          loading={resyncing}
          disabled={disabled || !item.isSynced || syncing}
        >
          Re-sync
        </Button>
      </resyncFetcher.Form>

      <syncProductsFetcher.Form method="post">
        <input type="hidden" name="intent" value="sync_products" />
        <input type="hidden" name="magentoCategoryId" value={item.magentoCategoryId} />
        <input type="hidden" name="collectionId" value={item.shopifyCollectionId || ""} />

        <Button
          size="slim"
          submit
          loading={syncingProducts}
          disabled={
            disabled ||
            !item.shopifyCollectionId ||
            syncing ||
            resyncing ||
            syncingProducts
          }
        >
          Sync products
        </Button>
      </syncProductsFetcher.Form>
    </InlineStack>
  );
}

export default function CategorySyncPage() {
  const fetcher = useFetcher();
  const syncRedirectsFetcher = useFetcher();
  const pushRedirectsFetcher = useFetcher();
  const shopify = useAppBridge();

  const [isBulkSyncing, setIsBulkSyncing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const [isBulkProductSyncing, setIsBulkProductSyncing] = useState(false);
  const [productProgress, setProductProgress] = useState({ done: 0, total: 0 });

  const items = fetcher.data?.items ?? [];
  const unsyncedItems = items.filter((i) => !i.isSynced);
  const allSynced = unsyncedItems.length === 0;

  const syncingRedirects = syncRedirectsFetcher.state !== "idle";
  const pushingRedirects = pushRedirectsFetcher.state !== "idle";

  const handleFetch = () => {
    fetcher.submit({ intent: "fetch" }, { method: "POST" });
  };

  useEffect(() => {
    const t = setTimeout(handleFetch, 200);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (syncRedirectsFetcher.state === "idle" && syncRedirectsFetcher.data?.success) {
      const updated = Number(syncRedirectsFetcher.data?.updated || 0);
      const skipped = Number(syncRedirectsFetcher.data?.skipped || 0);
      shopify.toast.show(`Synced category URLs: ${updated} updated, ${skipped} skipped`);
      handleFetch();
    }
  }, [syncRedirectsFetcher.state]);

  useEffect(() => {
    if (pushRedirectsFetcher.state === "idle" && pushRedirectsFetcher.data?.success) {
      const created = Number(pushRedirectsFetcher.data?.created || 0);
      const failed = Number(pushRedirectsFetcher.data?.failed || 0);
      shopify.toast.show(`Pushed redirects: ${created} created, ${failed} failed`);
    }
  }, [pushRedirectsFetcher.state]);

  const handleSyncCategoryRedirects = () => {
    syncRedirectsFetcher.submit(
      { intent: "sync_category_redirects" },
      { method: "POST" }
    );
  };

  const handlePushShopifyRedirects = () => {
    pushRedirectsFetcher.submit(
      { intent: "push_shopify_category_redirects" },
      { method: "POST" }
    );
  };

  const handleExportRedirectCsv = () => {
    downloadRedirectCsv(items);
    shopify.toast.show("Redirect CSV exported");
  };

  const syncAllProducts = async () => {
    const syncedCategories = items.filter((i) => i.isSynced && i.shopifyCollectionId);

    if (syncedCategories.length === 0) return;

    setIsBulkProductSyncing(true);
    setProductProgress({ done: 0, total: syncedCategories.length });

    for (const item of syncedCategories) {
      const fd = new FormData();
      fd.append("intent", "sync_products");
      fd.append("magentoCategoryId", item.magentoCategoryId);
      fd.append("collectionId", item.shopifyCollectionId);

      await fetch(window.location.pathname, {
        method: "POST",
        body: fd,
      });

      setProductProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    setIsBulkProductSyncing(false);
    shopify.toast.show("All products synced");
  };

  const syncAll = async () => {
    if (unsyncedItems.length === 0) return;

    setIsBulkSyncing(true);
    setProgress({ done: 0, total: unsyncedItems.length });

    for (const item of unsyncedItems) {
      const fd = new FormData();
      fd.append("intent", "sync");
      fd.append("magentoCategoryId", item.magentoCategoryId);
      fd.append("name", item.name);
      fd.append("image", item.image || "");
      fd.append("metaTitle", item.metaTitle || "");
      fd.append("metaDescription", item.metaDescription || "");
      fd.append("description", item.description || "");
      fd.append("redirectFrom", item.redirectFrom || "");
      fd.append("redirectTo", item.redirectTo || "");

      await fetch(window.location.pathname, {
        method: "POST",
        body: fd,
      });

      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    setIsBulkSyncing(false);
    handleFetch();
    shopify.toast.show("All categories synced");
  };

  return (
    <Page title="Category Sync">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text variant="headingSm">Magento → Shopify Categories</Text>

              <InlineStack gap="200">
                <Button
                  onClick={handleFetch}
                  loading={fetcher.state !== "idle"}
                  disabled={isBulkSyncing || syncingRedirects || pushingRedirects}
                >
                  Fetch categories
                </Button>

                <Button
                  variant="primary"
                  onClick={syncAll}
                  loading={isBulkSyncing}
                  disabled={allSynced || isBulkSyncing || syncingRedirects || pushingRedirects}
                >
                  Sync all
                </Button>
              </InlineStack>
            </InlineStack>

            <InlineStack gap="200">
              <Button
                variant="secondary"
                onClick={syncAllProducts}
                loading={isBulkProductSyncing}
                disabled={items.length === 0 || isBulkSyncing || syncingRedirects || pushingRedirects}
              >
                Sync all products
              </Button>

              <Button
                variant="secondary"
                onClick={handleSyncCategoryRedirects}
                loading={syncingRedirects}
                disabled={items.length === 0 || isBulkSyncing || isBulkProductSyncing || pushingRedirects}
              >
                Sync category URLs
              </Button>

              <Button
                variant="primary"
                onClick={handlePushShopifyRedirects}
                loading={pushingRedirects}
                disabled={items.length === 0 || isBulkSyncing || isBulkProductSyncing || syncingRedirects}
              >
                Push Shopify redirects
              </Button>

              <Button
                variant="secondary"
                onClick={handleExportRedirectCsv}
                disabled={
                  items.length === 0 ||
                  isBulkSyncing ||
                  isBulkProductSyncing ||
                  syncingRedirects ||
                  pushingRedirects
                }
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

            {isBulkProductSyncing && (
              <BlockStack gap="200">
                <Text>
                  Syncing products {productProgress.done} / {productProgress.total}
                </Text>
                <ProgressBar
                  progress={(productProgress.done / productProgress.total) * 100}
                />
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        {items.length > 0 && (
          <Card padding="0">
            <Scrollable style={{ height: "600px" }}>
              <IndexTable
                itemCount={items.length}
                stickyHeader
                selectable={false}
                headings={[
                  { title: "Shopify Collection ID" },
                  { title: "Magento Category ID" },
                  { title: "Name" },
                  { title: "Redirect from" },
                  { title: "Redirect to" },
                  { title: "Action" },
                ]}
              >
                {items.map((item, index) => (
                  <IndexTable.Row
                    id={String(item.magentoCategoryId)}
                    key={item.magentoCategoryId}
                    position={index}
                  >
                    <IndexTable.Cell>{item.shopifyCollectionId || "-"}</IndexTable.Cell>
                    <IndexTable.Cell>{item.magentoCategoryId}</IndexTable.Cell>
                    <IndexTable.Cell>{item.name}</IndexTable.Cell>
                    <IndexTable.Cell>{item.redirectFrom || "-"}</IndexTable.Cell>
                    <IndexTable.Cell>{item.redirectTo || "-"}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <RowActions
                        item={item}
                        onDone={handleFetch}
                        disabled={isBulkSyncing || syncingRedirects || pushingRedirects}
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
