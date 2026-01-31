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

function asInt(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

// Magento image helpers
const MAGENTO_BASE_URL = "https://dev.megagastrostore.de";
function buildMagentoImageUrl(imagePath) {
  if (!imagePath) return null;
  if (imagePath.startsWith("http")) return imagePath;
  return `${MAGENTO_BASE_URL}${imagePath}`;
}

/**
 * ======================
 * SHOPIFY PUBLISH HELPERS
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

  const intentsNeedMagento = new Set(["fetch", "sync", "resync"]);
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

  // sync product
  if (intent === "sync_products") {
    const magentoCategoryId = asInt(formData.get("magentoCategoryId"));
    const collectionId = asString(formData.get("collectionId"));

    if (!magentoCategoryId || !collectionId) {
      throw new Response("Missing magentoCategoryId/collectionId", { status: 400 });
    }

    // 1) lấy mapping category -> product_ids_json từ API
    const res = await fetch(`${MAGENTO_BASE}/rest/V1/shopify/category-products`);
    if (!res.ok) throw new Response("Failed to fetch category-products", { status: 500 });

    const data = await res.json();
    const items = data?.items ?? [];

    const row = items.find((x) => Number(x.category_id) === Number(magentoCategoryId));
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

    // 2) chỉ lấy những product đã sync sang shopify (có shopifyProductId)
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

    // 3) add products vào collection (chunk 250 để an toàn)
    const chunks = chunk(shopifyProductIds, 250);
    const jobs = [];
    for (const ids of chunks) {
      const job = await addProductsToCollection(admin, { collectionId, productIds: ids });
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
   * FETCH MAGENTO CATEGORIES
   */
  if (intent === "fetch") {
    const res = await fetch(
      `${MAGENTO_BASE}/rest/V1/shopify/categories`
    );

    if (!res.ok) {
      throw new Response("Failed to fetch Magento categories", { status: 500 });
    }

    const magentoData = await res.json();
    const mapped = await prisma.collectionMapCategory.findMany();

    const mappedByMagentoId = new Map(
      mapped.map((m) => [m.magentoCategoryId, m])
    );

    const items = magentoData.items.map((cat) => {
      const map = mappedByMagentoId.get(cat.category_id);

      return {
        magentoCategoryId: cat.category_id,
        name: cat.name,
        shopifyCollectionId: map?.collectionId ?? null,
        isSynced: Boolean(map),

        image: cat.image,
        metaTitle: cat.meta_title,
        metaDescription: cat.meta_description,
        description: cat.description,
      };
    });

    return { items };
  }

  /**
   * SYNC / RESYNC
   */
  if (intent === "sync" || intent === "resync") {
    const magentoCategoryId = asInt(formData.get("magentoCategoryId"));
    const name = asString(formData.get("name"));

    const metaTitle = asString(formData.get("metaTitle"));
    const metaDescription = asString(formData.get("metaDescription"));
    const description = asString(formData.get("description"));

    const imagePath = asString(formData.get("image"));
    const imageSrc = buildMagentoImageUrl(imagePath);

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

    /**
     * CREATE
     */
    if (intent === "sync") {
      const res = await admin.graphql(
        `#graphql
        mutation CreateCollection($input: CollectionInput!) {
          collectionCreate(input: $input) {
            collection { id }
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

      // 🔥 PUBLISH COLLECTION
      await publishCollection(admin, collectionId);

      await prisma.collectionMapCategory.create({
        data: {
          magentoCategoryId,
          name,
          collectionId,
        },
      });

      return { success: true };
    }

    /**
     * UPDATE
     */
    const collectionId = asString(formData.get("collectionId"));
    if (!collectionId) {
      throw new Response("Missing collectionId", { status: 400 });
    }

    const res = await admin.graphql(
      `#graphql
      mutation UpdateCollection($input: CollectionInput!) {
        collectionUpdate(input: $input) {
          collection { id }
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

    // 🔥 ENSURE PUBLISHED
    await publishCollection(admin, collectionId);

    await prisma.collectionMapCategory.update({
      where: { collectionId },
      data: { name },
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
  const syncing =
    syncFetcher.state === "loading" ||
    syncFetcher.state === "submitting";
  const resyncing =
    resyncFetcher.state === "loading" ||
    resyncFetcher.state === "submitting";
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
            !item.shopifyCollectionId || // ✅ chỉ khi category đã sync
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
  const shopify = useAppBridge();

  const [isBulkSyncing, setIsBulkSyncing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const [isBulkProductSyncing, setIsBulkProductSyncing] = useState(false);
  const [productProgress, setProductProgress] = useState({ done: 0, total: 0 });


  const items = fetcher.data?.items ?? [];
  const unsyncedItems = items.filter((i) => !i.isSynced).slice(0, 10);
  const allSynced = unsyncedItems.length === 0;

  const handleFetch = () => {
    fetcher.submit({ intent: "fetch" }, { method: "POST" });
  };

  useEffect(() => {
    const t = setTimeout(handleFetch, 200);
    return () => clearTimeout(t);
  }, []);

  const syncAllProducts = async () => {
    const syncedCategories = items.filter(
      (i) => i.isSynced && i.shopifyCollectionId
    );

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
          <InlineStack align="space-between">
            <Text variant="headingSm">Magento → Shopify Categories</Text>

            <InlineStack gap="200">
              <Button
                onClick={handleFetch}
                loading={fetcher.state !== "idle"}
                disabled={isBulkSyncing}
              >
                Fetch categories
              </Button>

              <Button
                variant="primary"
                onClick={syncAll}
                loading={isBulkSyncing}
                disabled={allSynced || isBulkSyncing}
              >
                Sync all
              </Button>
            </InlineStack>
          </InlineStack>
          <Button
            variant="secondary"
            onClick={syncAllProducts}
            loading={isBulkProductSyncing}
            disabled={items.length === 0 || isBulkSyncing}
          >
            Sync all products
          </Button>
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
                progress={
                  (productProgress.done / productProgress.total) * 100
                }
              />
            </BlockStack>
          )}

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
                  { title: "Action" },
                ]}
              >
                {items.map((item, index) => (
                  <IndexTable.Row
                    id={String(item.magentoCategoryId)}
                    key={item.magentoCategoryId}
                    position={index}
                  >
                    <IndexTable.Cell>
                      {item.shopifyCollectionId || "-"}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{item.magentoCategoryId}</IndexTable.Cell>
                    <IndexTable.Cell>{item.name}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <RowActions
                        item={item}
                        onDone={handleFetch}
                        disabled={isBulkSyncing}
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
