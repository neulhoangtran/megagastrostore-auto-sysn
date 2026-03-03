import { useFetcher } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
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
    Spinner,
    Banner
} from "@shopify/polaris";

/*
=====================================
SERVER
=====================================
*/

async function ensureDefinition(admin, key) {
    const check = await admin.graphql(`
    query {
      metafieldDefinitions(first: 50, ownerType: PRODUCT, namespace: "magento") {
        nodes { key }
      }
    }
  `);

    const json = await check.json();
    const defs = json?.data?.metafieldDefinitions?.nodes ?? [];
    if (defs.find(d => d.key === key)) return;

    const create = await admin.graphql(`
    mutation Create($input: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $input) {
        userErrors { message }
      }
    }
  `, {
        variables: {
            input: {
                name: `Magento ${key}`,
                namespace: "magento",
                key,
                type: "list.product_reference",
                ownerType: "PRODUCT"
            }
        }
    });

    const createJson = await create.json();
    const errs = createJson?.data?.metafieldDefinitionCreate?.userErrors ?? [];
    if (errs.length) throw new Error(errs[0].message);
}

async function checkProductExists(admin, id) {
    const res = await admin.graphql(`
    query($id: ID!) {
      product(id: $id) { id }
    }
  `, { variables: { id } });

    const json = await res.json();
    return Boolean(json?.data?.product?.id);
}

export const loader = async ({ request }) => {
    await authenticate.admin(request);
    return null;
};

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    const MAGENTO_BASE = String(await getSettingOr("magento_url", "")).trim();
    if (!MAGENTO_BASE) {
        return { success: false, message: "Magento URL not configured" };
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
                return { success: false, message: "Failed to fetch Magento links" };
            }

            const json = await res.json();
            const rawItems = json?.items ?? [];

            const maps = await prisma.productMapMagento.findMany();
            const mapByMagentoId = new Map(
                maps.map(m => [m.magentoProductId, m])
            );

            const grouped = new Map();

            for (const item of rawItems) {
                const parentId = item.parent_id;
                const linkedId = item.linked_id;

                if (!grouped.has(parentId)) {
                    grouped.set(parentId, {
                        parent_id: parentId,
                        related: [],
                        upsell: [],
                        crosssell: [],
                    });
                }

                const group = grouped.get(parentId);
                const linkedMap = mapByMagentoId.get(linkedId);
                if (!linkedMap?.shopifyProductId) continue;

                const entry = {
                    shopifyId: linkedMap.shopifyProductId,
                    position: item.position ?? 0
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
                    related: group.related.sort(sort).map(x => x.shopifyId),
                    upsell: group.upsell.sort(sort).map(x => x.shopifyId),
                    crosssell: group.crosssell.sort(sort).map(x => x.shopifyId),
                });
            }

            return { success: true, items: rows };

        } catch (e) {
            return { success: false, message: e.message };
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
                return { success: false, message: "Missing Shopify Product ID" };
            }

            const exists = await checkProductExists(admin, shopifyProductId);
            if (!exists) {
                return {
                    success: false,
                    message: "Shopify product does not exist or was deleted"
                };
            }

            const related = JSON.parse(formData.get("related") || "[]");
            const upsell = JSON.parse(formData.get("upsell") || "[]");
            const crosssell = JSON.parse(formData.get("crosssell") || "[]");

            await ensureDefinition(admin, "related");
            await ensureDefinition(admin, "upsell");
            await ensureDefinition(admin, "crosssell");

            const metafields = [];

            const build = (key, list) => {
                if (!list.length) return;
                metafields.push({
                    ownerId: shopifyProductId,
                    namespace: "magento",
                    key,
                    type: "list.product_reference",
                    value: JSON.stringify(list)
                });
            };

            build("related", related);
            build("upsell", upsell);
            build("crosssell", crosssell);

            if (metafields.length) {
                const res = await admin.graphql(`
          mutation Set($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors { message }
            }
          }
        `, { variables: { metafields } });

                const json = await res.json();
                const errs = json?.data?.metafieldsSet?.userErrors ?? [];
                if (errs.length) {
                    return { success: false, message: errs[0].message };
                }
            }

            return { success: true };

        } catch (e) {
            return { success: false, message: e.message };
        }
    }

    return null;
};

/*
=====================================
CLIENT
=====================================
*/

export default function ProductLinkPage() {
    const fetcher = useFetcher();

    const [items, setItems] = useState([]);
    const [isSyncing, setIsSyncing] = useState(false);
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const [error, setError] = useState(null);
    const [rowLoading, setRowLoading] = useState(null);

    const isFetching = fetcher.state !== "idle";

    useEffect(() => {
        if (fetcher.data?.items) setItems(fetcher.data.items);
        if (fetcher.data?.success === false) setError(fetcher.data.message);
    }, [fetcher.data]);

    const handleFetch = () => {
        setError(null);
        fetcher.submit({ intent: "fetch" }, { method: "POST" });
    };

    const safeJson = async (res) => {
        try {
            return await res.json();
        } catch {
            return { success: false, message: "Invalid server response" };
        }
    };

    const syncOne = async (item) => {
        setError(null);
        setRowLoading(item.parent_id);

        const exists = await checkProductExists(item.shopify_id);

        if (!exists) {
            setError(`Product ${item.shopify_id} does not exist on Shopify`);
            setRowLoading(null);
            return;
        }

        const fd = new FormData();
        fd.append("intent", "sync");
        fd.append("shopifyProductId", item.shopify_id);
        fd.append("related", JSON.stringify(item.related));
        fd.append("upsell", JSON.stringify(item.upsell));
        fd.append("crosssell", JSON.stringify(item.crosssell));

        const res = await fetch(window.location.pathname, {
            method: "POST",
            body: fd
        });

        let json;
        try {
            json = await res.json();
        } catch {
            setError("Invalid server response");
            setRowLoading(null);
            return;
        }

        if (!json.success) {
            setError(json.message);
        }

        setRowLoading(null);
    };

    const syncAll = async () => {
        setError(null);
        setIsSyncing(true);
        setProgress({ done: 0, total: items.length });

        for (const item of items) {

            const exists = await checkProductExists(item.shopify_id);

            if (!exists) {
                setError(`Product ${item.shopify_id} does not exist on Shopify`);
                setIsSyncing(false);
                return; // STOP
            }

            const fd = new FormData();
            fd.append("intent", "sync");
            fd.append("shopifyProductId", item.shopify_id);
            fd.append("related", JSON.stringify(item.related));
            fd.append("upsell", JSON.stringify(item.upsell));
            fd.append("crosssell", JSON.stringify(item.crosssell));

            const res = await fetch(window.location.pathname, {
                method: "POST",
                body: fd
            });

            let json;
            try {
                json = await res.json();
            } catch {
                setError("Invalid server response");
                setIsSyncing(false);
                return;
            }

            if (!json.success) {
                setError(json.message);
                setIsSyncing(false);
                return;
            }

            setProgress(p => ({ ...p, done: p.done + 1 }));
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
                        <Button onClick={handleFetch} loading={isFetching}>
                            Fetch Links
                        </Button>

                        <Button
                            variant="primary"
                            onClick={syncAll}
                            loading={isSyncing}
                            disabled={!items.length || isSyncing}
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
                    {isFetching ? (
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
                                    { title: "Action" }
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
                                        <IndexTable.Cell>{item.name}</IndexTable.Cell>
                                        <IndexTable.Cell>
                                            <Button
                                                size="slim"
                                                loading={rowLoading === item.parent_id}
                                                onClick={() => syncOne(item)}
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