// app/routes/app.settings.jsx
import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Page,
  Card,
  TextField,
  Button,
  BlockStack,
  InlineStack,
  Text,
  Banner,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * ======================
 * DB NOTE (Prisma)
 * ======================
 * Bạn cần có table key/value để tự động lưu mọi field.
 *
 * model AppSetting {
 *   key       String  @id
 *   value     String
 *   createdAt DateTime @default(now())
 *   updatedAt DateTime @updatedAt
 * }
 */

/**
 * ======================
 * SETTINGS FIELDS (UI)
 * ======================
 * ✅ Muốn thêm field mới: chỉ cần thêm object vào đây (không phải sửa loader/action).
 */
const FIELDS = [
  {
    key: "magento_url",
    label: "Magento base URL",
    placeholder: "https://dev.megagastrostore.de",
    helpText: "https//sample.com",
  },
  // {
  //   key: "magento_push_endpoint",
  //   label: "Magento push endpoint",
  //   placeholder: "/rest/V1/shopify/product-map",
  //   helpText: "Endpoint nhận mapping (Magento sẽ tự xử lý).",
  // },
  // {
  //   key: "magento_token",
  //   label: "Magento token (optional)",
  //   placeholder: "Bearer token (nếu endpoint cần auth)",
  //   type: "password",
  //   helpText: "Để trống nếu Magento không cần auth.",
  // },
];

function normalizeBaseUrl(url) {
  const u = String(url || "").trim();
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

function joinUrl(base, path) {
  const b = normalizeBaseUrl(base);
  const p = String(path || "").trim();
  if (!b) return p || "";
  if (!p) return b;
  if (p.startsWith("http://") || p.startsWith("https://")) return p;
  if (p.startsWith("/")) return `${b}${p}`;
  return `${b}/${p}`;
}

/**
 * ======================
 * SERVER
 * ======================
 */

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const rows = await prisma.appSetting.findMany();
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const mapCount = await prisma.productMapMagento.count();

  return {
    settings,
    mapCount,
    // optional: show last push info if stored
    lastPushAt: settings.last_push_at || null,
    lastPushResult: settings.last_push_result || null,
  };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  // ===== SAVE SETTINGS (generic) =====
  if (intent === "save_settings") {
    const pairs = [...formData.entries()]
      .filter(([k]) => String(k).startsWith("s_"))
      .map(([k, v]) => [String(k).slice(2), String(v ?? "")]);

    // upsert in 1 transaction
    await prisma.$transaction(
      pairs.map(([key, value]) =>
        prisma.appSetting.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        })
      )
    );

    return { success: true };
  }

  // ===== PUSH PRODUCT MAP TO MAGENTO =====
  if (intent === "push_product_map") {
    // load settings from DB
    const rows = await prisma.appSetting.findMany({
      where: { key: { in: ["magento_url", "magento_push_endpoint", "magento_token"] } },
    });
    const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));

    const magentoUrl = settings.magento_url || "";
    const endpoint = "/V1/shopify/get-list-shopify-product-id";
    const token = settings.magento_token || "";

    const targetUrl = joinUrl(magentoUrl, endpoint);

    if (!targetUrl) {
      return {
        success: false,
        error: "Missing magento_url or magento_push_endpoint",
      };
    }

    const maps = await prisma.productMapMagento.findMany({
      select: {
        magentoProductId: true,
        shopifyProductId: true,
        sku: true,
        name: true,
      },
      orderBy: { magentoProductId: "asc" },
    });

    // payload tối giản: chỉ cần id mapping
    const payload = {
      status: "success",
      total: maps.length,
      items: maps.map((m) => ({
        magento_product_id: m.magentoProductId,
        shopify_product_id: m.shopifyProductId,
        sku: m.sku || null,
        name: m.name || null,
      })),
    };

    const headers = { "Content-Type": "application/json" };
    if (token && token.trim()) {
      // nếu Magento bạn dùng Bearer token, bạn nhập thẳng "Bearer xxx" vào field.
      headers["Authorization"] = token.trim();
    }

    let ok = false;
    let respText = "";
    let statusCode = 0;

    try {
      const resp = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      statusCode = resp.status;
      ok = resp.ok;

      // Magento có thể trả JSON hoặc text
      respText = await resp.text();
    } catch (e) {
      respText = String(e?.message || e);
      ok = false;
    }

    // lưu log kết quả (optional)
    const nowIso = new Date().toISOString();
    const resultSummary = JSON.stringify({
      ok,
      status: statusCode,
      at: nowIso,
      // cắt bớt log để tránh DB phình
      response: respText?.slice(0, 2000) || "",
    });

    await prisma.$transaction([
      prisma.appSetting.upsert({
        where: { key: "last_push_at" },
        create: { key: "last_push_at", value: nowIso },
        update: { value: nowIso },
      }),
      prisma.appSetting.upsert({
        where: { key: "last_push_result" },
        create: { key: "last_push_result", value: resultSummary },
        update: { value: resultSummary },
      }),
    ]);

    return {
      success: ok,
      pushed: maps.length,
      targetUrl,
      statusCode,
      responsePreview: respText?.slice(0, 500) || "",
    };
  }

  return { success: false, error: "Invalid intent" };
};

/**
 * ======================
 * CLIENT
 * ======================
 */

export default function AppSettingsPage() {
  const { settings, mapCount, lastPushAt, lastPushResult } = useLoaderData();
  const shopify = useAppBridge();

  const saveFetcher = useFetcher();
  const pushFetcher = useFetcher();

  const saving = saveFetcher.state !== "idle";
  const pushing = pushFetcher.state !== "idle";

  // form state (auto from settings)
  const initialForm = useMemo(() => {
    const f = {};
    for (const field of FIELDS) {
      // không auto-fill token (tuỳ bạn). Nếu muốn fill thì đổi logic này.
      if (field.key === "magento_token") {
        f[field.key] = "";
      } else {
        f[field.key] = settings?.[field.key] ?? "";
      }
    }
    return f;
  }, [settings]);

  const [form, setForm] = useState(initialForm);

  useEffect(() => {
    setForm(initialForm);
  }, [initialForm]);

  useEffect(() => {
    if (saveFetcher.state === "idle" && saveFetcher.data?.success) {
      shopify.toast.show("Settings saved");
    } else if (saveFetcher.state === "idle" && saveFetcher.data?.success === false) {
      shopify.toast.show(saveFetcher.data?.error || "Save failed");
    }
  }, [saveFetcher.state]);

  useEffect(() => {
    if (pushFetcher.state === "idle" && pushFetcher.data) {
      if (pushFetcher.data.success) {
        shopify.toast.show(
          `Pushed ${Number(pushFetcher.data.pushed || 0)} mappings to Magento`
        );
      } else {
        shopify.toast.show(pushFetcher.data.error || "Push failed");
      }
    }
  }, [pushFetcher.state]);

  const pushInfo = (() => {
    if (!lastPushAt && !lastPushResult) return null;
    try {
      const obj = lastPushResult ? JSON.parse(lastPushResult) : null;
      return { at: lastPushAt, ...obj };
    } catch {
      return { at: lastPushAt, raw: lastPushResult };
    }
  })();

  return (
    <Page title="App settings">
      <BlockStack gap="400">
        {/* SETTINGS FORM */}
        <Card>
          <BlockStack gap="300">
            <Text variant="headingSm">Magento connection</Text>

            {FIELDS.map((f) => (
              <TextField
                key={f.key}
                label={f.label}
                value={form[f.key] ?? ""}
                onChange={(v) => setForm((p) => ({ ...p, [f.key]: v }))}
                placeholder={f.placeholder}
                helpText={f.helpText}
                type={f.type}
                autoComplete="off"
              />
            ))}

            <InlineStack gap="200" align="end">
              <saveFetcher.Form method="post">
                <input type="hidden" name="intent" value="save_settings" />
                {Object.entries(form).map(([k, v]) => (
                  <input key={k} type="hidden" name={`s_${k}`} value={String(v ?? "")} />
                ))}
                <Button submit variant="primary" loading={saving}>
                  Save settings
                </Button>
              </saveFetcher.Form>
            </InlineStack>

            {saveFetcher.data?.success === false && (
              <Banner tone="critical">
                <p>{saveFetcher.data?.error || "Save failed"}</p>
              </Banner>
            )}
          </BlockStack>
        </Card>

        {/* PUSH MAPPING */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text variant="headingSm">Push ProductMap to Magento</Text>
                <Text tone="subdued">
                  Current mappings in DB: <b>{mapCount}</b>
                </Text>
              </BlockStack>

              <pushFetcher.Form method="post">
                <input type="hidden" name="intent" value="push_product_map" />
                <Button
                  submit
                  loading={pushing}
                  onClick={(e) => {
                    if (
                      !window.confirm(
                        "Push toàn bộ mapping (Magento ID ↔ Shopify ID) sang Magento. Continue?"
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

            {pushInfo?.at && (
              <Banner tone={pushInfo?.ok ? "success" : "warning"}>
                <p>
                  Last push: <b>{pushInfo.at}</b>
                  {typeof pushInfo.status !== "undefined" ? (
                    <>
                      {" "}
                      — status: <b>{pushInfo.status}</b>
                    </>
                  ) : null}
                </p>
                {pushInfo?.response ? (
                  <p style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                    {String(pushInfo.response).slice(0, 500)}
                  </p>
                ) : null}
              </Banner>
            )}

            {pushFetcher.data?.success === false && (
              <Banner tone="critical">
                <p>{pushFetcher.data?.error || "Push failed"}</p>
                {pushFetcher.data?.responsePreview ? (
                  <p style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                    {pushFetcher.data.responsePreview}
                  </p>
                ) : null}
              </Banner>
            )}

            {pushFetcher.data?.success && (
              <Banner tone="success">
                <p>
                  Pushed <b>{Number(pushFetcher.data.pushed || 0)}</b> mappings to:
                </p>
                <p style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                  {pushFetcher.data.targetUrl}
                </p>
              </Banner>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
