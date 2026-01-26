// app/routes/app.product.jsx
import { Pagination, TextField  } from "@shopify/polaris";
import he from "he";
import { useFetcher } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { useAppBridge } from "@shopify/app-bridge-react";
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
function asInt(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function asString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}
function safeParseJsonArray(value) {
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function decodeMagentoHtml(html) {
  if (!html) return "";
  return he.decode(html);
}
/**
 * ======================
 * SHOPIFY HELPERS
 * ======================
 */

async function getProductImageMediaIds(admin, productId) {
  const res = await admin.graphql(
    `#graphql
    query GetMedia($id: ID!) {
      product(id: $id) {
        media(first: 250) {
          nodes {
            __typename
            ... on MediaImage { id }
          }
        }
      }
    }`,
    { variables: { id: productId } }
  );

  const json = await res.json();
  const nodes = json?.data?.product?.media?.nodes ?? [];
  return nodes
    .filter((m) => m.__typename === "MediaImage" && m.id)
    .map((m) => m.id);
}

async function deleteProductMedia(admin, productId, mediaIds) {
  if (!mediaIds?.length) return;

  const res = await admin.graphql(
    `#graphql
    mutation DeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        userErrors { message }
      }
    }`,
    { variables: { productId, mediaIds } }
  );

  const json = await res.json();
  const errs = json?.data?.productDeleteMedia?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);
}


async function getOnlineStorePublicationId(admin) {
  const res = await admin.graphql(
    `#graphql
    query {
      publications(first: 20) {
        nodes { id name }
      }
    }`,
  );
  const json = await res.json();
  const pubs = json?.data?.publications?.nodes ?? [];
  const onlineStore = pubs.find((p) => p.name === "Online Store");
  if (!onlineStore) throw new Error("Online Store publication not found");
  return onlineStore.id;
}

async function publishProduct(admin, productId) {
  const publicationId = await getOnlineStorePublicationId(admin);

  const res = await admin.graphql(
    `#graphql
    mutation Publish($id: ID!, $pub: ID!) {
      publishablePublish(id: $id, input: { publicationId: $pub }) {
        userErrors { message }
      }
    }`,
    { variables: { id: productId, pub: publicationId } },
  );

  const json = await res.json();
  const errs = json?.data?.publishablePublish?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);
}

async function getFirstLocationId(admin) {
  const res = await admin.graphql(
    `#graphql
    query {
      locations(first: 5) {
        nodes { id name }
      }
    }`,
  );
  const json = await res.json();
  const loc = json?.data?.locations?.nodes?.[0];
  if (!loc?.id) throw new Error("No location found");
  return loc.id;
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
      variables: { inventoryItemId, locationId },
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
    },
  );

  const json = await res.json();
  const errs = json?.data?.inventorySetOnHandQuantities?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);
}
async function updateVariantWeightREST(session, {
  variantId,
  weight,
  weightUnit = "kg",
}) {
//   if (!variantId) return;

//   const res = await shopify.api.rest.Variant.update({
//     session,
//     id: Number(variantId),
//     weight: Number(weight),
//     weight_unit: "kg",
//   });

//   if (!res?.variant) {
//     throw new Error("Update variant weight failed: empty response");
//   }

//   return {
//     id: res.variant.id,
//     weight: res.variant.weight,
//     unit: res.variant.weight_unit,
//   };
}

async function updateInventoryItemSku(admin, { inventoryItemId, sku }) {
  if (!sku) return;
  const res = await admin.graphql(
    `#graphql
    mutation UpdateInvItem($id: ID!, $input: InventoryItemInput!) {
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
    },
  );
  const json = await res.json();
  const errs = json?.data?.inventoryItemUpdate?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);
}

async function updateVariantPricing(admin, {
  productId,
  variantId,
  price,
}) {
  const res = await admin.graphql(
    `#graphql
    mutation UpdateVariant(
      $productId: ID!
      $variants: [ProductVariantsBulkInput!]!
    ) {
      productVariantsBulkUpdate(
        productId: $productId
        variants: $variants
      ) {
        userErrors { message }
      }
    }`,
    {
      variables: {
        productId,
        variants: [
          {
            id: variantId,
            price: price?.toString() ?? "0",
          },
        ],
      },
    },
  );

  const json = await res.json();
  const errs = json?.data?.productVariantsBulkUpdate?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);
}

async function createOrUpdateProductBase(admin, { productId, title, descriptionHtml, seoTitle, seoDescription }) {
  // Nếu có productId => update, không có => create
  if (!productId) {
    const res = await admin.graphql(
      `#graphql
      mutation CreateProduct($input: ProductInput!) {
        productCreate(input: $input) {
          product {
            id
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
            descriptionHtml,
            seo: {
              title: seoTitle,
              description: seoDescription,
            },
          },
        },
      },
    );

    const json = await res.json();
    const payload = json?.data?.productCreate;
    const errs = payload?.userErrors ?? [];
    if (errs.length) throw new Error(errs[0].message);

    const p = payload?.product;
    const v = p?.variants?.nodes?.[0];
    if (!p?.id || !v?.id || !v?.inventoryItem?.id) {
      throw new Error("productCreate: missing product/variant/inventoryItem id");
    }

    return {
      productId: p.id,
      variantId: v.id,
      inventoryItemId: v.inventoryItem.id,
      created: true,
    };
  }

  const res = await admin.graphql(
    `#graphql
    mutation UpdateProduct($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
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
          id: productId,
          title,
          descriptionHtml,
          seo: {
            title: seoTitle,
            description: seoDescription,
          },
        },
      },
    },
  );

  const json = await res.json();
  const payload = json?.data?.productUpdate;
  const errs = payload?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);

  const p = payload?.product;
  const v = p?.variants?.nodes?.[0];
  if (!p?.id || !v?.id || !v?.inventoryItem?.id) {
    throw new Error("productUpdate: missing product/variant/inventoryItem id");
  }

  return {
    productId: p.id,
    variantId: v.id,
    inventoryItemId: v.inventoryItem.id,
    created: false,
  };
}

async function fetchMagentoProductImages(magentoProductId) {
  const res = await fetch(
    `http://dev.megagastrostore.de/rest/V1/shopify/product/${magentoProductId}/images`
  );

  if (!res.ok) {
    throw new Error(`Fetch images failed (${res.status})`);
  }

  const data = await res.json();
  console.log(data);
  // data dạng: ["success", [url1, url2]]
  const status = data?.[0];
  const list = data?.[1];

  if (status !== "success") return [];
  if (!Array.isArray(list)) return [];

  // clean + unique
  return Array.from(
    new Set(list.map((u) => String(u || "").trim()).filter(Boolean))
  );
}
async function addProductImages(admin, {
  productId,
  magentoProductId,
  replaceExisting = false,
}) {
  // lấy danh sách từ API mới
  const apiUrls = magentoProductId
    ? await fetchMagentoProductImages(magentoProductId)
    : [];

  // nếu vẫn có imageUrl thì đưa lên đầu, và remove trùng trong apiUrls
  let gallery = apiUrls;
  // if (imageUrl) gallery = gallery.filter((u) => u !== imageUrl);

  // const urls = [...(imageUrl ? [imageUrl] : []), ...gallery].filter(Boolean);
  if (!gallery.length) return;

  if (replaceExisting) {
    const oldMediaIds = await getProductImageMediaIds(admin, productId);
    await deleteProductMedia(admin, productId, oldMediaIds);
  }

  const media = gallery.map((u) => ({
    mediaContentType: "IMAGE",
    originalSource: u,
  }));

  const res = await admin.graphql(
    `#graphql
    mutation AddMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        userErrors { message }
      }
    }`,
    { variables: { productId, media } }
  );

  const json = await res.json();
  const errs = json?.data?.productCreateMedia?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);
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
//   const { admin } = await authenticate.admin(request);
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  /**
   * FETCH MAGENTO PRODUCTS
   */
  if (intent === "fetch") {
    const page = Number(formData.get("page")) || 1;
    const pageSize = Number(formData.get("page_size")) || 500;
    const url = new URL("http://dev.megagastrostore.de/rest/V1/shopify/products");
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(pageSize));
    const productId = String(formData.get("product_id") ?? "").trim();
    if (productId) url.searchParams.set("product_id", productId);
    const res = await fetch(url.toString());

    if (!res.ok) {
      throw new Response("Failed to fetch Magento products", { status: 500 });
    }

    const magento = await res.json();

    const mapped = await prisma.productMapMagento.findMany();
    const mappedByMagentoId = new Map(mapped.map((m) => [m.magentoProductId, m]));

    const items = (magento.items ?? []).map((p) => {
      const map = mappedByMagentoId.get(p.product_id);

      return {
        magentoProductId: p.product_id,
        name: p.name,
        sku: p.sku,
        price: p.special_price ?? p.price,
        qty: p.salable_qty ?? p.qty ?? 0,

        shopifyProductId: map?.shopifyProductId ?? null,
        isSynced: Boolean(map),
        weight: p.weight ?? 0,
        // fields needed for sync/resync
        description: p.description,
        metaTitle: p.meta_title,
        metaDescription: p.meta_description,
        imageUrl: p.image_url,
        galleryJson: p.gallery_json,
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
   * SYNC / RESYNC (simple product)
   */
  if (intent === "sync" || intent === "resync") {
    const magentoProductId = asInt(formData.get("magentoProductId"));
    const name = asString(formData.get("name"));
    const sku = asString(formData.get("sku"));
    const price = asString(formData.get("price"));
    const qty = asInt(formData.get("qty"), 0);
    const weight = asString(formData.get("weight"));
    const descriptionRaw = asString(formData.get("description"));
    const description = decodeMagentoHtml(descriptionRaw);
    const metaTitle = asString(formData.get("metaTitle"));
    const metaDescription = asString(formData.get("metaDescription"));
    const imageUrl = asString(formData.get("imageUrl"));
    const galleryJson = asString(formData.get("galleryJson"));

    if (!magentoProductId || !name) {
      throw new Response("Missing required fields", { status: 400 });
    }

    // find mapped product for resync
    let existing = null;
    if (intent === "resync") {
      existing = await prisma.productMapMagento.findUnique({
        where: { magentoProductId },
      });
      if (!existing?.shopifyProductId) {
        throw new Error("This product is not synced yet");
      }
    }

    // 1) create or update base product (title/desc/seo) and get default variant + inventoryItem
    const base = await createOrUpdateProductBase(admin, {
      productId: existing?.shopifyProductId ?? null,
      title: name,
      descriptionHtml: description || "",
      seoTitle: metaTitle || name,
      seoDescription: metaDescription || "",
    });

    // 2) update variant price (API mới: bulk update)
    await updateVariantPricing(admin, {
      productId: base.productId,
      variantId: base.variantId,
      price
    });
    // 3) update SKU (inventoryItemUpdate)
    await updateInventoryItemSku(admin, {
      inventoryItemId: base.inventoryItemId,
      sku,
    });

    // 4) inventory on hand
    const locationId = await getFirstLocationId(admin);

    // 🔥 BẮT BUỘC activate trước
    await activateInventoryItem(admin, {
        inventoryItemId: base.inventoryItemId,
        locationId,
    });

    // set on hand
    await setInventoryOnHand(admin, {
        inventoryItemId: base.inventoryItemId,
        locationId,
        quantity: qty,
    });

    // 5) images
    await addProductImages(admin, {
        productId: base.productId,
        // imageUrl,
        magentoProductId,
        replaceExisting: intent === "resync",
    });

    // 6) publish product
    await publishProduct(admin, base.productId);

    // await updateVariantWeightREST(session,{
    //     shop: session.shop,
    //     accessToken: session.accessToken,
    //     variantId: base.variantId,
    //     weight: weight, // kg
    //     unit: "kg",
    // });

    // 7) upsert mapping DB
    await prisma.productMapMagento.upsert({
      where: { magentoProductId },
      create: {
        magentoProductId,
        shopifyProductId: base.productId,
        sku: sku || null,
        name,
      },
      update: {
        shopifyProductId: base.productId,
        sku: sku || null,
        name,
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
  const resyncing = resyncFetcher.state === "loading" || resyncFetcher.state === "submitting";

  useEffect(() => {
    if (syncFetcher.state === "idle" && syncFetcher.data?.success) {
      shopify.toast.show("Product synced");
      onDone();
    }
  }, [syncFetcher.state]);

  useEffect(() => {
    if (resyncFetcher.state === "idle" && resyncFetcher.data?.success) {
      shopify.toast.show("Product re-synced");
      onDone();
    }
  }, [resyncFetcher.state]);

  const HiddenFields = () => (
    <>
      <input type="hidden" name="magentoProductId" value={item.magentoProductId} />
      <input type="hidden" name="name" value={item.name} />
      <input type="hidden" name="sku" value={asString(item.sku)} />
      <input type="hidden" name="price" value={asString(item.price)} />
      <input type="hidden" name="qty" value={asString(item.qty)} />
      <input type="hidden" name="description" value={asString(item.description)} />
      <input type="hidden" name="metaTitle" value={asString(item.metaTitle)} />
      <input type="hidden" name="metaDescription" value={asString(item.metaDescription)} />
      <input type="hidden" name="imageUrl" value={asString(item.imageUrl)} />
      <input type="hidden" name="galleryJson" value={asString(item.galleryJson)} />
      <input type="hidden" name="weight" value={asString(item.weight)} />
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
  const shopify = useAppBridge();
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [searchId, setSearchId] = useState("");
  const [isBulkSyncing, setIsBulkSyncing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [pageInputFocusValue, setPageInputFocusValue] = useState("");
  const items = fetcher.data?.items ?? [];

  

  // test sync 10
  const unsyncedItems = items.filter((i) => !i.isSynced);//.slice(0, 10);
  const allSynced = unsyncedItems.length === 0;

  const handleFetch = (nextPage = page, nextProductId = searchId) => {
    if (String(nextProductId || "").trim().length > 0) {
      nextPage = 1;
    }
    setPage(nextPage);
    fetcher.submit(
      { intent: "fetch", page: String(nextPage), page_size: "500",product_id: String(nextProductId || "").trim(), },
      { method: "POST" }
    );
  };

  const pageInfo = fetcher.data
  ? {
      page: fetcher.data.page ?? 1,
      totalPage: fetcher.data.total_page ?? 1,
      total: fetcher.data.total ?? 0,
      pageSize: fetcher.data.page_size ?? 500,
    }
  : { page: 1, totalPage: 1, total: 0, pageSize: 500 };

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.page != null) {
      setPage(fetcher.data.page);
      setPageInput(String(fetcher.data.page));
    }
  }, [fetcher.state, fetcher.data?.page]);
  
  // auto fetch (same as category)
  useEffect(() => {
    const t = setTimeout(() => handleFetch(1), 200);
    return () => clearTimeout(t);
  }, []);

  const syncAll = async () => {
    if (unsyncedItems.length === 0) return;

    setIsBulkSyncing(true);
    setProgress({ done: 0, total: unsyncedItems.length });

    for (const item of unsyncedItems) {
      const fd = new FormData();
      fd.append("intent", "sync");
      fd.append("magentoProductId", item.magentoProductId);
      fd.append("name", item.name);
      fd.append("sku", item.sku || "");
      fd.append("price", item.price || "");
      fd.append("qty", item.qty ?? 0);

      fd.append("description", item.description || "");
      fd.append("metaTitle", item.metaTitle || "");
      fd.append("metaDescription", item.metaDescription || "");
      fd.append("imageUrl", item.imageUrl || "");
      fd.append("galleryJson", item.galleryJson || "");

      await fetch(window.location.pathname, {
        method: "POST",
        body: fd,
      });

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

    const p = Math.max(1, Math.min(total, Math.trunc(n)));
    return p;
  };

  const goToPage = (raw) => {
    const p = normalizePage(raw);
    if (p == null) {
      // nhập bậy thì reset về trang hiện tại
      setPageInput(String(pageInfo.page ?? 1));
      return;
    }

    const current = Number(pageInfo.page ?? 1);
    if (p === current) {
      // không đổi gì thì đừng fetch
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
                disabled={isBulkSyncing}
              >
                Fetch products
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

          {isBulkSyncing && (
            <BlockStack gap="200">
              <Text>
                Syncing {progress.done} / {progress.total}
              </Text>
              <ProgressBar progress={(progress.done / progress.total) * 100} />
            </BlockStack>
          )}
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
                        // nếu user không đổi text thì thôi
                        if (pageInput === pageInputFocusValue) return;
                        goToPage(pageInput);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          goToPage(pageInput);
                          e.currentTarget.blur(); // optional: blur để đóng focus
                        }
                      }}
                    />
                </div>

                <Text>/ {pageInfo.totalPage} — Total {pageInfo.total} items</Text>
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
                    <IndexTable.Cell>
                      <RowActions
                        item={item}
                        onDone={() => handleFetch(page)} 
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
