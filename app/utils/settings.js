// app/helpers/settings.server.js
import prisma from "../db.server";

/**
 * Lấy 1 setting theo key
 * @returns string | null
 */
export async function getSetting(key) {
  if (!key) return null;

  const row = await prisma.appSetting.findUnique({
    where: { key: String(key) },
    select: { value: true },
  });

  return row?.value ?? null;
}

/**
 * Lấy setting + fallback
 * @returns string
 */
export async function getSettingOr(key, fallback = "") {
  const v = await getSetting(key);
  return v == null || v === "" ? String(fallback) : String(v);
}

/**
 * Lấy nhiều setting 1 lần (tiết kiệm query)
 * @returns object { [key]: value }
 */
export async function getSettings(keys = []) {
  const list = (keys || []).map((k) => String(k)).filter(Boolean);
  if (!list.length) return {};

  const rows = await prisma.appSetting.findMany({
    where: { key: { in: list } },
    select: { key: true, value: true },
  });

  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

/**
 * Cache trong process (Node) để giảm query.
 * - TTL mặc định 30s
 * - Dùng cho loader/action gọi liên tục
 */
const _cache = new Map(); // key -> { value, expiresAt }

export async function getSettingCached(key, { ttlMs = 30_000 } = {}) {
  const k = String(key || "");
  if (!k) return null;

  const now = Date.now();
  const hit = _cache.get(k);
  if (hit && hit.expiresAt > now) return hit.value;

  const value = await getSetting(k);
  _cache.set(k, { value, expiresAt: now + ttlMs });
  return value;
}

/**
 * Nếu bạn update setting ở đâu đó, gọi hàm này để clear cache key đó
 */
export function invalidateSettingCache(key) {
  _cache.delete(String(key || ""));
}
