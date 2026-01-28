import { useFetcher } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useAppBridge } from "@shopify/app-bridge-react";
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
  Badge,
} from "@shopify/polaris";

/**
 * ======================
 * CONSTANTS & HELPERS
 * ======================
 */

const NAMESPACE = "magento";
const MAGENTO_ATTR_API =
  "/rest/V1/shopify/product_attr";

function mapMagentoInputToShopifyType(frontendInput, attributeCode) {
  // ưu tiên theo code
  if (attributeCode === "short_description") return "rich_text_field";

  const map = {
    text: "single_line_text_field",
    textarea: "multi_line_text_field", // default
    varchar: "single_line_text_field",
    price: "number_decimal",
    decimal: "number_decimal",
    select: "single_line_text_field",
    multiselect: "list.single_line_text_field",
    boolean: "boolean",
  };

  return map[frontendInput] || null;
}

function isSelectInput(input) {
  return input === "select" || input === "multiselect";
}

async function deleteAllMagentoMetafieldDefinitions(admin) {
  const res = await admin.graphql(
    `#graphql
    query($ns: String!) {
      metafieldDefinitions(ownerType: PRODUCT, first: 250, namespace: $ns) {
        nodes { id namespace key }
      }
    }`,
    { variables: { ns: NAMESPACE } }
  );

  const json = await res.json();
  const defs = json?.data?.metafieldDefinitions?.nodes ?? [];

  let deleted = 0;
  for (const def of defs) {
    const delRes = await admin.graphql(
      `#graphql
      mutation DeleteDef($id: ID!) {
        metafieldDefinitionDelete(id: $id, deleteAllAssociatedMetafields: true) {
          deletedDefinitionId
          userErrors { message }
        }
      }`,
      { variables: { id: def.id } }
    );

    const delJson = await delRes.json();
    const errs = delJson?.data?.metafieldDefinitionDelete?.userErrors ?? [];
    if (errs.length) throw new Error(errs[0].message);

    deleted += 1;
  }

  return deleted;
}
async function listMagentoMetaobjectDefinitions(admin) {
  let after = null;
  const out = [];

  while (true) {
    const res = await admin.graphql(
      `#graphql
      query($after: String) {
        metaobjectDefinitions(first: 250, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id type name }
        }
      }`,
      { variables: { after } }
    );

    const json = await res.json();
    const conn = json?.data?.metaobjectDefinitions;
    const nodes = conn?.nodes ?? [];

    for (const d of nodes) {
      const t = String(d?.type || "");
      if (t.startsWith("app")) out.push(d);
    }

    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  return out;
}



async function bulkDeleteMetaobjectsByType(admin, type) {
  const res = await admin.graphql(
    `#graphql
    mutation BulkDelete($where: MetaobjectBulkDeleteWhereCondition!) {
      metaobjectBulkDelete(where: $where) {
        job { id done }
        userErrors { message }
      }
    }`,
    { variables: { where: { type } } }
  );

  const json = await res.json();
  const errs = json?.data?.metaobjectBulkDelete?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);

  return json?.data?.metaobjectBulkDelete?.job ?? null;
}

async function deleteMetaobjectDefinitionById(admin, id) {
  const res = await admin.graphql(
    `#graphql
    mutation DeleteDef($id: ID!) {
      metaobjectDefinitionDelete(id: $id) {
        deletedId
        userErrors { message }
      }
    }`,
    { variables: { id } }
  );

  const json = await res.json();
  const errs = json?.data?.metaobjectDefinitionDelete?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);

  return true;
}

async function deleteAllMagentoMetaobjects(admin) {
  const defs = await listMagentoMetaobjectDefinitions(admin);

  let deletedDefinitions = 0;
  for (const d of defs) {
    await deleteMetaobjectDefinitionById(admin, d.id);
    deletedDefinitions += 1;
  }

  return { deletedDefinitions };
}



function mapSelectInputToMetafieldType(input) {
  return input === "multiselect"
    ? "list.metaobject_reference"
    : "metaobject_reference";
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function EllipsisText({ children, maxWidth = 140, as = "span" }) {
  return (
    <span
      title={typeof children === "string" ? children : undefined}
      style={{
        display: "inline-block",
        maxWidth,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        verticalAlign: "middle",
      }}
    >
      <Text as={as}>{children}</Text>
    </span>
  );
}

/**
 * ======================
 * SHOPIFY GRAPHQL HELPERS
 * ======================
 */

async function getExistingMagentoMetafieldKeys(admin) {
  const res = await admin.graphql(
    `#graphql
    query {
      metafieldDefinitions(
        ownerType: PRODUCT
        first: 250
        namespace: "${NAMESPACE}"
      ) {
        nodes { namespace key }
      }
    }`
  );

  const json = await res.json();
  const defs = json?.data?.metafieldDefinitions?.nodes ?? [];
  return new Set(defs.map((d) => `${d.namespace}.${d.key}`));
}

async function createMetafieldDefinition(admin, { key, name, type, metaobjectDefinitionId }) {
  const def = {
    ownerType: "PRODUCT",
    namespace: NAMESPACE,
    key,
    name,
    type,
  };

  if (type.includes("metaobject_reference")) {
    if (!metaobjectDefinitionId) {
      throw new Error("Missing metaobjectDefinitionId for metaobject_reference metafield");
    }
    def.validations = [
      {
        name: "metaobject_definition_id",
        value: metaobjectDefinitionId,
      },
    ];
  }

  const res = await admin.graphql(
    `#graphql
    mutation CreateDef($def: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $def) {
        userErrors { message }
      }
    }`,
    {
      variables: {
        def: def,
      },
    }
  );

  const json = await res.json();
  const errors = json?.data?.metafieldDefinitionCreate?.userErrors ?? [];
  if (errors.length) throw new Error(errors[0].message);
}

async function deleteAllMagentoMetafields(admin) {
  const res = await admin.graphql(
    `#graphql
    query {
      metafieldDefinitions(
        ownerType: PRODUCT
        first: 250
        namespace: "${NAMESPACE}"
      ) {
        nodes { id }
      }
    }`
  );

  const json = await res.json();
  const defs = json?.data?.metafieldDefinitions?.nodes ?? [];

  for (const def of defs) {
    await admin.graphql(
      `#graphql
      mutation DeleteDef($id: ID!) {
        metafieldDefinitionDelete(id: $id) {
          deletedDefinitionId
          userErrors { message }
        }
      }`,
      { variables: { id: def.id } }
    );
  }

  return defs.length;
}

/**
 * ======================
 * METAOBJECT HELPERS (ONLY FOR select/multiselect)
 * ======================
 */

// Query definition by type (needed when already exists, or to update access/displayNameKey)
async function getMetaobjectDefinitionByType(admin, { type }) {
  const res = await admin.graphql(
    `#graphql
    query GetDef($type: String!) {
      metaobjectDefinitionByType(type: $type) {
        id
        type
        name
        displayNameKey
        access {
          storefront
          admin
        }
      }
    }`,
    { variables: { type } }
  );

  const json = await res.json();
  return json?.data?.metaobjectDefinitionByType ?? null;
}

async function updateMetaobjectDefinition(admin, { id }) {
  const res = await admin.graphql(
    `#graphql
    mutation UpdateDef($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
      metaobjectDefinitionUpdate(id: $id, definition: $definition) {
        metaobjectDefinition {
          id
          displayNameKey
          access { storefront admin }
        }
        userErrors { message }
      }
    }`,
    {
      variables: {
        id,
        definition: {
          // Ensure storefront can read + ensure entries show label as display name
          access: { storefront: "PUBLIC_READ", admin: "MERCHANT_READ_WRITE" },
          displayNameKey: "label",
        },
      },
    }
  );

  const json = await res.json();
  const errs = json?.data?.metaobjectDefinitionUpdate?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);

  return json?.data?.metaobjectDefinitionUpdate?.metaobjectDefinition ?? null;
}

async function ensureMetaobjectDefinition(admin, { type, name }) {
  const _existing = await getMetaobjectDefinitionByType(admin, { type });
  if (_existing?.id) {
    return _existing.id;
  }
  // IMPORTANT:
  // - type MUST be app-reserved to allow setting access.admin
  // - Example: "$app:magento_tuerart_option"
  const res = await admin.graphql(
    `#graphql
    mutation CreateMetaobjectDefinition($definition: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $definition) {
        metaobjectDefinition {
          id
          type
          displayNameKey
          access { storefront admin }
        }
        userErrors { message }
      }
    }`,
    {
      variables: {
        definition: {
          name,
          type,
          access: { admin: "MERCHANT_READ_WRITE", storefront: "PUBLIC_READ" },
          displayNameKey: "label",
          fieldDefinitions: [
            { name: "Label", key: "label", type: "single_line_text_field" },
            { name: "Value", key: "value", type: "single_line_text_field" },
          ],
        },
      },
    }
  );

  const json = await res.json();
  const payload = json?.data?.metaobjectDefinitionCreate;

  // If created OK
  if (payload?.metaobjectDefinition?.id) {
    return payload.metaobjectDefinition.id;
  }

  // If errors: allow "already exists", then fetch & update to ensure storefront + displayNameKey
  const msg = payload?.userErrors?.[0]?.message || "";
  if (msg && !msg.toLowerCase().includes("already exists")) {
    throw new Error(msg);
  }

  const existing = await getMetaobjectDefinitionByType(admin, { type });
  if (!existing?.id) {
    // Fallback: if we cannot fetch it, surface the original message
    throw new Error(msg || "Metaobject definition exists but cannot be fetched");
  }

  // Ensure displayNameKey & storefront access are correct
  const needsUpdate =
    existing.displayNameKey !== "label" ||
    existing.access?.storefront !== "PUBLIC_READ" ||
    existing.access?.admin !== "MERCHANT_READ_WRITE";

  if (needsUpdate) {
    await updateMetaobjectDefinition(admin, { id: existing.id });
  }

  return existing.id;
}

async function getExistingMetaobjectOptionLabels(admin, { handle }) {
  const res = await admin.graphql(
    `#graphql
    query GetMetaobjects($type: String!) {
      metaobjects(type: $type, first: 250) {
        nodes {
          id
          fields { key value }
        }
      }
    }`,
    { variables: { type: handle } }
  );

  const json = await res.json();
  const nodes = json?.data?.metaobjects?.nodes ?? [];

  const labels = new Set();
  for (const n of nodes) {
    const label = n.fields?.find((f) => f.key === "label")?.value;
    if (label) labels.add(label);
  }
  return labels;
}

async function createMetaobjectOption(admin, { handle, label, value }) {
  const res = await admin.graphql(
    `#graphql
    mutation CreateMetaobject($input: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $input) {
        metaobject { id }
        userErrors { message }
      }
    }`,
    {
      variables: {
        input: {
          type: handle,
          fields: [
            { key: "label", value: String(label ?? "").trim() },
            { key: "value", value: String(value ?? "").trim() },
          ],
        },
      },
    }
  );

  const json = await res.json();
  const errs = json?.data?.metaobjectCreate?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);
}

/**
 * Sync Magento options -> metaobject records (anti-duplicate by label)
 */
async function syncMetaobjectOptions(admin, { handle, options }) {
  if (!Array.isArray(options) || options.length === 0) return { created: 0 };

  const existingLabels = await getExistingMetaobjectOptionLabels(admin, {
    handle,
  });

  let created = 0;
  for (const opt of options) {
    const label = String(opt?.label ?? "").trim();
    if (!label) continue;

    if (existingLabels.has(label)) continue;

    await createMetaobjectOption(admin, {
      handle,
      label,
      value: opt?.value ?? "",
    });

    existingLabels.add(label);
    created += 1;
  }

  return { created };
}

/**
 * Fetch the full Magento attribute (so we can get values/options)
 */
async function fetchMagentoAttributeByCode(magentoUrl,code) {
  const res = await fetch(magentoUrl + MAGENTO_ATTR_API);
  if (!res.ok) {
    throw new Error("Failed to fetch Magento attributes for options");
  }
  const json = await res.json();
  const attrs = Array.isArray(json?.[2]) ? json[2] : [];
  return attrs.find((a) => a.attribute_code === code) || null;
}

/**
 * ======================
 * CLEAR METAOBJECTS HELPERS
 * ======================
 */

async function listMetaobjectEntryIdsByType(admin, { type }) {
  const res = await admin.graphql(
    `#graphql
    query ListEntries($type: String!) {
      metaobjects(type: $type, first: 250) {
        nodes { id }
      }
    }`,
    { variables: { type } }
  );

  const json = await res.json();
  const nodes = json?.data?.metaobjects?.nodes ?? [];
  return nodes.map((n) => n.id).filter(Boolean);
}

async function deleteMetaobjectEntry(admin, { id }) {
  const res = await admin.graphql(
    `#graphql
    mutation DeleteEntry($id: ID!) {
      metaobjectDelete(id: $id) {
        deletedId
        userErrors { message }
      }
    }`,
    { variables: { id } }
  );

  const json = await res.json();
  const errs = json?.data?.metaobjectDelete?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);
}

async function deleteMetaobjectDefinitionByType(admin, { type }) {
  const def = await getMetaobjectDefinitionByType(admin, { type });
  if (!def?.id) return false;

  const res = await admin.graphql(
    `#graphql
    mutation DeleteDef($id: ID!) {
      metaobjectDefinitionDelete(id: $id) {
        deletedId
        userErrors { message }
      }
    }`,
    { variables: { id: def.id } }
  );

  const json = await res.json();
  const errs = json?.data?.metaobjectDefinitionDelete?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0].message);

  return true;
}

async function deleteMetaobjectsByTypes(admin, types) {
  const uniq = Array.from(new Set((types || []).filter(Boolean)));
  let deletedEntries = 0;
  let deletedDefinitions = 0;

  for (const type of uniq) {
    // delete entries first
    const entryIds = await listMetaobjectEntryIdsByType(admin, { type });
    for (const id of entryIds) {
      await deleteMetaobjectEntry(admin, { id });
      deletedEntries += 1;
    }

    // then delete definition
    const deleted = await deleteMetaobjectDefinitionByType(admin, { type });
    if (deleted) deletedDefinitions += 1;
  }

  return { deletedEntries, deletedDefinitions };
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

  let MAGENTO_BASE = null;
  const intentsNeedMagento = new Set(["fetch", "sync", "resync"]);
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

  if (intent === "clear_magento_global") {
    const deletedMetafieldDefinitions = await deleteAllMagentoMetafieldDefinitions(admin);
    const { deletedDefinitions: deletedMetaobjectDefinitions } =
      await deleteAllMagentoMetaobjects(admin);

    return {
      success: true,
      deletedMetafieldDefinitions,
      deletedMetaobjectDefinitions,
    };
  }
  /**
   * FETCH MAGENTO ATTRIBUTES
   */
  if (intent === "fetch") {
    const res = await fetch(MAGENTO_BASE + MAGENTO_ATTR_API);
    if (!res.ok) {
      throw new Response("Failed to fetch Magento attributes", { status: 500 });
    }

    const json = await res.json();
    const attrs = Array.isArray(json?.[2]) ? json[2] : [];

    const mapped = await prisma.attributeMapMetafield.findMany();
    const mappedByCode = new Map(mapped.map((m) => [m.magentoAttributeCode, m]));

    const items = attrs.map((a) => {
      const map = mappedByCode.get(a.attribute_code);

      return {
        code: a.attribute_code,
        label: a.frontend_label,
        input: a.frontend_input,
        expectedShopifyType: isSelectInput(a.frontend_input)
          ? mapSelectInputToMetafieldType(a.frontend_input)
          : mapMagentoInputToShopifyType(a.frontend_input, a.attribute_code),

        shopifyNamespace: map?.shopifyNamespace ?? null,
        shopifyKey: map?.shopifyKey ?? null,
        shopifyType: map?.shopifyType ?? null,

        metaobjectHandle: map?.metaobjectHandle ?? null,
        metaobjectTypeId: map?.metaobjectTypeId ?? null,

        isSynced: Boolean(map),
      };
    });

    return { items };
  }

  /**
   * SYNC / RESYNC ATTRIBUTE
   */
  if (intent === "sync" || intent === "resync") {
    const code = formData.get("code");
    const label = formData.get("label");
    const input = formData.get("input");

    if (!code || !input) {
      throw new Response("Missing required fields", { status: 400 });
    }

    const existingKeys = await getExistingMagentoMetafieldKeys(admin);
    const fullKey = `${NAMESPACE}.${code}`;

    let shopifyType;
    let metaobjectHandle = null;
    let metaobjectTypeId = null;
    let metaobjectOptionsCreated = 0;

    if (isSelectInput(input)) {
      shopifyType = mapSelectInputToMetafieldType(input);

      // IMPORTANT: app-reserved type to allow admin access configuration
      metaobjectHandle = `$app:magento_${code}_option`;

      const existingMap = await prisma.attributeMapMetafield.findUnique({
        where: { magentoAttributeCode: code },
      });

      const ensuredMetaobjectId = await ensureMetaobjectDefinition(admin, {
        type: metaobjectHandle,
        name: label || code,
      });

      metaobjectTypeId = ensuredMetaobjectId || existingMap?.metaobjectTypeId || null;

      const attr = await fetchMagentoAttributeByCode(MAGENTO_BASE , code);
      const options = Array.isArray(attr?.values) ? attr.values : [];

      const result = await syncMetaobjectOptions(admin, {
        handle: metaobjectHandle,
        options,
      });

      metaobjectOptionsCreated = result.created || 0;
    } else {
      shopifyType = mapMagentoInputToShopifyType(input, code);
      if (!shopifyType) {
        throw new Error(`Unsupported attribute type: ${input}`);
      }
    }

    if (intent === "sync" && !existingKeys.has(fullKey)) {
      await createMetafieldDefinition(admin, {
        key: code,
        name: label || code,
        type: shopifyType,
        metaobjectDefinitionId: shopifyType.includes("metaobject_reference")
          ? metaobjectTypeId
          : null,
      });
    }

    await prisma.attributeMapMetafield.upsert({
      where: { magentoAttributeCode: code },
      create: {
        magentoAttributeCode: code,
        shopifyNamespace: NAMESPACE,
        shopifyKey: code,
        shopifyType,
        metaobjectHandle,
        metaobjectTypeId,
      },
      update: {
        shopifyType,
        metaobjectHandle,
        metaobjectTypeId,
      },
    });

    return {
      success: true,
      intent,
      metaobjectOptionsCreated,
    };
  }

  /**
   * CLEAR ALL
   * - Delete metafield definitions (namespace magento)
   * - Delete mapped metaobject entries + definitions
   * - Delete DB mapping
   */
  if (intent === "clear_all") {
    const mapped = await prisma.attributeMapMetafield.findMany({
      where: { shopifyNamespace: NAMESPACE },
      select: { metaobjectHandle: true },
    });

    const metaobjectTypes = mapped.map((m) => m.metaobjectHandle).filter(Boolean);

    const deletedCount = await deleteAllMagentoMetafields(admin);

    const { deletedEntries, deletedDefinitions } = await deleteMetaobjectsByTypes(
      admin,
      metaobjectTypes
    );

    await prisma.attributeMapMetafield.deleteMany({
      where: { shopifyNamespace: NAMESPACE },
    });

    return {
      success: true,
      deletedCount,
      deletedMetaobjectEntries: deletedEntries,
      deletedMetaobjectDefinitions: deletedDefinitions,
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

  const syncing = syncFetcher.state !== "idle";
  const resyncing = resyncFetcher.state !== "idle";

  useEffect(() => {
    if (syncFetcher.state === "idle" && syncFetcher.data?.success) {
      const created = Number(syncFetcher.data?.metaobjectOptionsCreated || 0);
      if (created > 0) {
        shopify.toast.show(`Attribute synced (+${created} options)`);
      } else {
        shopify.toast.show("Attribute synced");
      }
      onDone();
    }
  }, [syncFetcher.state]);

  useEffect(() => {
    if (resyncFetcher.state === "idle" && resyncFetcher.data?.success) {
      const created = Number(resyncFetcher.data?.metaobjectOptionsCreated || 0);
      if (created > 0) {
        shopify.toast.show(`Attribute re-synced (+${created} options)`);
      } else {
        shopify.toast.show("Attribute re-synced");
      }
      onDone();
    }
  }, [resyncFetcher.state]);

  return (
    <InlineStack gap="200" wrap={false}>
      <syncFetcher.Form method="post">
        <input type="hidden" name="intent" value="sync" />
        <input type="hidden" name="code" value={item.code} />
        <input type="hidden" name="label" value={item.label || ""} />
        <input type="hidden" name="input" value={item.input} />
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
        <input type="hidden" name="code" value={item.code} />
        <input type="hidden" name="label" value={item.label || ""} />
        <input type="hidden" name="input" value={item.input} />
        <Button
          size="slim"
          variant="secondary"
          submit
          loading={resyncing}
          disabled={disabled || !item.isSynced || syncing}
        >
          Re-sync
        </Button>
      </resyncFetcher.Form>
    </InlineStack>
  );
}

export default function AttributeSyncPage() {
  const fetcher = useFetcher();
  const clearFetcher = useFetcher();
  const shopify = useAppBridge();

  const [isBulkSyncing, setIsBulkSyncing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const items = fetcher.data?.items ?? [];
  const unsyncedItems = items.filter((i) => !i.isSynced);
  const allSynced = unsyncedItems.length === 0;

  const clearGlobalFetcher = useFetcher();

  useEffect(() => {
    if (clearGlobalFetcher.state === "idle" && clearGlobalFetcher.data?.success) {
      const mf = Number(clearGlobalFetcher.data.deletedMetafieldDefinitions || 0);
      const md = Number(clearGlobalFetcher.data.deletedMetaobjectDefinitions || 0);
      shopify.toast.show(`Cleared ${mf} metafield defs (magento) + ${md} metaobject defs ($app:magento_*_option)`);
      handleFetch();
    }
  }, [clearGlobalFetcher.state]);

  const handleFetch = () => {
    fetcher.submit({ intent: "fetch" }, { method: "POST" });
  };

  useEffect(() => {
    const t = setTimeout(handleFetch, 200);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (clearFetcher.state === "idle" && clearFetcher.data?.success) {
      const mf = Number(clearFetcher.data.deletedCount || 0);
      const e = Number(clearFetcher.data.deletedMetaobjectEntries || 0);
      const d = Number(clearFetcher.data.deletedMetaobjectDefinitions || 0);

      shopify.toast.show(
        `Cleared ${mf} magento metafields, ${e} metaobject entries, ${d} metaobject definitions`
      );
      handleFetch();
    }
  }, [clearFetcher.state]);

  const syncAll = async () => {
    if (unsyncedItems.length === 0) return;

    setIsBulkSyncing(true);
    setProgress({ done: 0, total: unsyncedItems.length });

    for (const item of unsyncedItems) {
      const fd = new FormData();
      fd.append("intent", "sync");
      fd.append("code", item.code);
      fd.append("label", item.label || "");
      fd.append("input", item.input);

      await fetch(window.location.pathname, {
        method: "POST",
        body: fd,
      });

      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    setIsBulkSyncing(false);
    handleFetch();
    shopify.toast.show("All attributes synced");
  };

  return (
    <Page title="Attribute Sync">
      <BlockStack gap="400">
        <Card>
            <InlineStack align="end">
              <clearGlobalFetcher.Form method="post">
                <input type="hidden" name="intent" value="clear_magento_global" />
                <Button
                  tone="critical"
                  submit
                  loading={clearGlobalFetcher.state !== "idle"}
                  disabled={isBulkSyncing}
                  onClick={(e) => {
                    if (
                      !window.confirm(
                        "This will DELETE ALL PRODUCT metafield definitions in namespace 'magento' (and their values) AND ALL metaobjects/metaobject definitions of type '$app:magento_*_option'. Continue?"
                      )
                    ) {
                      e.preventDefault();
                    }
                  }}
                >
                  Clear ALL magento metafields + magento_*_option metaobjects
                </Button>
              </clearGlobalFetcher.Form>
            </InlineStack>
          </Card>

        <Card>
          <InlineStack align="space-between">
            <Text variant="headingSm">Magento → Shopify Attributes</Text>

            <InlineStack gap="200">
              <Button
                onClick={handleFetch}
                loading={fetcher.state !== "idle"}
                disabled={isBulkSyncing}
              >
                Fetch attributes
              </Button>

              <Button
                variant="primary"
                onClick={syncAll}
                loading={isBulkSyncing}
                disabled={allSynced || isBulkSyncing}
              >
                Sync all
              </Button>

              <clearFetcher.Form method="post">
                <input type="hidden" name="intent" value="clear_all" />
                <Button
                  tone="critical"
                  submit
                  loading={clearFetcher.state !== "idle"}
                  disabled={isBulkSyncing}
                  onClick={(e) => {
                    if (
                      !window.confirm(
                        "This will DELETE ALL metafield definitions with namespace 'magento' AND mapped metaobjects. Continue?"
                      )
                    ) {
                      e.preventDefault();
                    }
                  }}
                >
                  Clear all
                </Button>
              </clearFetcher.Form>
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

        {items.length > 0 && (
          <Card padding="0">
            <Scrollable style={{ height: "600px" }}>
              <IndexTable
                itemCount={items.length}
                selectable={false}
                stickyHeader
                headings={[
                  { title: "Shopify Key" },
                  { title: "Shopify Type" },
                  { title: "M2 Code" },
                  { title: "M2 Label" },
                  { title: "M2 Input" },
                  { title: "Action" },
                ]}
              >
                {items.map((item, index) => (
                  <IndexTable.Row id={item.code} key={item.code} position={index}>
                    <IndexTable.Cell>
                      {item.shopifyKey ? (
                        <Text as="code">{item.shopifyKey}</Text>
                      ) : (
                        <Text tone="subdued">N/A</Text>
                      )}
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <Badge tone="info">
                        {item.shopifyType || item.expectedShopifyType || "N/A"}
                      </Badge>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <EllipsisText maxWidth={120} as="code">
                        {item.code}
                      </EllipsisText>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <EllipsisText maxWidth={180}>{item.label || "-"}</EllipsisText>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <Badge>{item.input}</Badge>
                    </IndexTable.Cell>

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
