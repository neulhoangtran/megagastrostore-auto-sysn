/**
 * menuJson: tree dạng [{id,label,children?}]
 * shopifyCollections: [{id,title}]
 *
 * Rule:
 * - collection bị xóa trên Shopify => remove khỏi menu
 * - collection mới chưa có trong menu => append xuống cuối (root)
 * - label luôn lấy theo title mới nhất từ Shopify
 */

function cleanMenu(nodes, shopifyMap) {
  return (nodes || [])
    .filter((node) => node && typeof node.id === "string" && shopifyMap.has(node.id))
    .map((node) => {
      const shopify = shopifyMap.get(node.id);
      const cleaned = {
        id: node.id,
        label: shopify?.title ?? node.label ?? node.id,
      };

      if (Array.isArray(node.children) && node.children.length > 0) {
        cleaned.children = cleanMenu(node.children, shopifyMap);
      }

      return cleaned;
    });
}

function collectIds(nodes, set = new Set()) {
  (nodes || []).forEach((n) => {
    if (!n || typeof n.id !== "string") return;
    set.add(n.id);
    if (n.children) collectIds(n.children, set);
  });
  return set;
}

function appendNewCollections(menu, shopifyCollections) {
  const existingIds = collectIds(menu);
  const newItems = (shopifyCollections || [])
    .filter((c) => c && typeof c.id === "string" && !existingIds.has(c.id))
    .map((c) => ({
      id: c.id,
      label: c.title,
    }));

  return [...menu, ...newItems];
}

export function mergeMenuWithShopify(menuJson, shopifyCollections) {
  const shopifyMap = new Map((shopifyCollections || []).map((c) => [c.id, c]));

  let menu = cleanMenu(menuJson || [], shopifyMap);
  menu = appendNewCollections(menu, shopifyCollections || []);

  return menu;
}
