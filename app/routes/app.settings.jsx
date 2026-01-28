// app/routes/app.settings.jsx
import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Page,
  Card,
  Text,
  TextField,
  Button,
  InlineStack,
  BlockStack,
  Banner,
  Divider,
} from "@shopify/polaris";

/**
 * ======================
 * DB HELPERS (NO SHOP)
 * ======================
 */
async function getSetting(key, fallback = "") {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  return row?.value ?? fallback;
}

async function setSetting(key, value) {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: String(value ?? "") },
    update: { value: String(value ?? "") },
  });
}

/**
 * ======================
 * UTILS
 * ======================
 */
function chunk(arr, size = 200) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizeBaseUrl(url) {
  const s = String(url || "").trim();
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function joinUrl(base, path) {
  const b = normalizeBaseUrl(base);
  const p = String(path || "").trim();
  if (!p) return b;
  if (p.startsWith("http")) return p;
  return p.startsWith("/") ? `${b}${p}` : `${b}/${p}`;
}

/**
 * ======================
 * SERVER
 * ======================
 */
export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const magentoUrl = await getSetting("magento_url", "https://dev.megagastrostore.de");
  const magentoEndpoint = await getSetting("magento_push_endpoint", "/rest/V1/shopify/product-map");
  const magentoToken = await getSetting("magento_token", ""); // optional

  return {
    magentoUrl,
    magentoEndpoint,
    // do NOT leak token to UI
    hasToken: Boolean(magentoToken),
  };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "save_settings") {
    const magentoUrl = String(formData.get("magentoUrl") || "").trim();
    const magentoEndpoint = String(formData.get("magentoEndpoint") || "").trim();
    const magentoToken = String(formData.get("magentoToken") || "").trim(); // optional

    if (!magentoUrl) throw new Response("Missing magentoUrl", { status: 400 });

    await setSetting("magento_url", magentoUrl);
    await setSetting("magento_push_endpoint", magentoEndpoint || "/rest/V1/shopify/product-map");

    // chỉ update token khi user nhập (để khỏi overwrite thành rỗng)
    if (magentoToken) {
      await setSetting("magento_token", magentoToken);
    }

    return { success: true, intent };
  }

  if (intent === "push_mapping") {
    const magentoUrl = await getSetting("magento_url", "");
    const magentoEndpoint = await getSetting("magento_push_endpoint", "/rest/V1/shopify/product-map");
    const magentoToken = await getSetting("magento_token", "");

    if (!magentoUrl) {
      return { success: false, intent, message: "Magento URL is empty. Please save settings first." };
    }

    // lấy mapping từ DB app
    const maps = await prisma.productMapMagento.findMany({
      select: {
        magentoProductId: true,
        shopifyProductId: true,
        sku: true,
        name: true,
        updatedAt: true,
      },
      orderBy: { magentoProductId: "asc" },
    });

    const items = maps.map((m) => ({
      magento_product_id: m.magentoProductId,
      shopify_product_id: m.shopifyProductId,
      sku: m.sku,
      name: m.name,
      updated_at: m.updatedAt,
    }));

    if (!items.length) {
      return { success: true, intent, pushed: 0, message: "No mapping rows found." };
    }

    const url = joinUrl(magentoUrl, magentoEndpoint);

    // chunk để tránh payload quá lớn
    const batches = chunk(items, 200);
    let pushed = 0;

    for (const batch of batches) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(magentoToken ? { Authorization: `Bearer ${magentoToken}` } : {}),
        },
        body: JSON.stringify({
          status: "success",
          total: batch.length,
          items: batch,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Push failed (${res.status}). ${text || ""}`.trim());
      }

      pushed += batch.length;
    }

    return { success: true, intent, pushed };
  }

  throw new Response("Invalid intent", { status: 400 });
};

/**
 * ======================
 * CLIENT
 * ======================
 */
export default function AppSettingsPage() {
  const shopify = useAppBridge();
  const data = useLoaderData();

  const saveFetcher = useFetcher();
  const pushFetcher = useFetcher();

  const saving = saveFetcher.state !== "idle";
  const pushing = pushFetcher.state !== "idle";

  const [magentoUrl, setMagentoUrl] = useState(data.magentoUrl || "");
  const [magentoEndpoint, setMagentoEndpoint] = useState(data.magentoEndpoint || "");
  const [magentoToken, setMagentoToken] = useState(""); // user nhập mới update
  const [hasToken, setHasToken] = useState(Boolean(data.hasToken));

  const pushUrlPreview = useMemo(
    () => joinUrl(magentoUrl, magentoEndpoint),
    [magentoUrl, magentoEndpoint]
  );

  useEffect(() => {
    if (saveFetcher.state === "idle" && saveFetcher.data?.success) {
      shopify.toast.show("Saved settings");
      if (magentoToken.trim()) {
        setHasToken(true);
        setMagentoToken("");
      }
    }
  }, [saveFetcher.state]);

  useEffect(() => {
    if (pushFetcher.state === "idle" && pushFetcher.data?.intent === "push_mapping") {
      if (pushFetcher.data?.success) {
        const pushed = Number(pushFetcher.data?.pushed || 0);
        shopify.toast.show(`Pushed ${pushed} mapping rows to Magento`);
      } else {
        shopify.toast.show(pushFetcher.data?.message || "Push failed");
      }
    }
  }, [pushFetcher.state]);

  const canPush = magentoUrl.trim().length > 0 && magentoEndpoint.trim().length > 0;

  return (
    <Page title="App settings">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text variant="headingSm">Magento connection</Text>

            <TextField
              label="Magento base URL"
              value={magentoUrl}
              onChange={setMagentoUrl}
              placeholder="https://dev.megagastrostore.de"
              autoComplete="off"
              helpText="Ví dụ: https://dev.megagastrostore.de (không cần dấu / cuối)"
            />

            <TextField
              label="Push endpoint (Magento)"
              value={magentoEndpoint}
              onChange={setMagentoEndpoint}
              placeholder="/rest/V1/shopify/product-map"
              autoComplete="off"
              helpText={`URL preview: ${pushUrlPreview}`}
            />

            <TextField
              label="Magento token (optional)"
              value={magentoToken}
              onChange={setMagentoToken}
              placeholder={hasToken ? "Token already saved (enter new to replace)" : "Bearer token..."}
              autoComplete="off"
              type="password"
              helpText="Nếu Magento endpoint không cần auth thì để trống."
            />

            <InlineStack gap="200" align="end">
              <saveFetcher.Form method="post">
                <input type="hidden" name="intent" value="save_settings" />
                <input type="hidden" name="magentoUrl" value={magentoUrl} />
                <input type="hidden" name="magentoEndpoint" value={magentoEndpoint} />
                <input type="hidden" name="magentoToken" value={magentoToken} />
                <Button submit variant="primary" loading={saving} disabled={saving || pushing}>
                  Save
                </Button>
              </saveFetcher.Form>
            </InlineStack>

            {saveFetcher.data?.success === false && saveFetcher.data?.message && (
              <Banner tone="critical">{saveFetcher.data.message}</Banner>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text variant="headingSm">Sync mapping to Magento</Text>
            <Text tone="subdued">
              Gửi bảng mapping (magentoProductId ↔ shopifyProductId) từ app sang Magento.
            </Text>

            {!canPush && (
              <Banner tone="warning">
                Bạn cần nhập Magento URL + endpoint trước khi Push.
              </Banner>
            )}

            <Divider />

            <InlineStack gap="200" align="end">
              <pushFetcher.Form method="post">
                <input type="hidden" name="intent" value="push_mapping" />
                <Button
                  submit
                  tone="critical"
                  loading={pushing}
                  disabled={!canPush || saving || pushing}
                  onClick={(e) => {
                    if (
                      !window.confirm(
                        "Push mapping toàn bộ sản phẩm sang Magento? (sẽ gửi theo batch)"
                      )
                    ) {
                      e.preventDefault();
                    }
                  }}
                >
                  Push mapping now
                </Button>
              </pushFetcher.Form>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
