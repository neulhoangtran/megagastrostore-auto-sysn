import { useEffect, useMemo, useRef, useState } from "react";
import {
  useLoaderData,
  useFetcher,
  useNavigate,
  useSearchParams,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Page,
  Card,
  Text,
  Icon,
  InlineStack,
  Modal,
  ResourceList,
  ResourceItem,
  Badge,
  Button,
} from "@shopify/polaris";
import {
  FolderIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DragHandleIcon,
} from "@shopify/polaris-icons";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettingOr } from "../utils/settings";

/* ============================ CONFIG ============================ */

const INDENT_WIDTH = 24;

/* ============================ HELPERS ============================ */

function buildTreeFromMagentoCategories(categories, magentoToShopifyMap) {
  const nodesByMagentoId = new Map();

  categories.forEach((cat) => {
    const collectionId = magentoToShopifyMap.get(Number(cat.category_id));
    if (!collectionId) return;

    nodesByMagentoId.set(Number(cat.category_id), {
      id: collectionId,
      label: cat.name,
      parentMagentoId: Number(cat.parent_id),
      children: [],
    });
  });

  const roots = [];

  nodesByMagentoId.forEach((node) => {
    const parent = nodesByMagentoId.get(node.parentMagentoId);
    parent ? parent.children.push(node) : roots.push(node);
  });

  const clean = (n) => ({
    id: n.id,
    label: n.label,
    ...(n.children.length ? { children: n.children.map(clean) } : {}),
  });

  return roots.map(clean);
}

function getExpandableIds(nodes, set = new Set()) {
  (nodes || []).forEach((n) => {
    if (n.children?.length) {
      set.add(n.id);
      getExpandableIds(n.children, set);
    }
  });
  return set;
}

function buildVersionName(prefix = "version") {
  const d = new Date();
  return `${prefix}-${d.getFullYear()}${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}${String(d.getDate()).padStart(2, "0")}-${String(
    d.getHours()
  ).padStart(2, "0")}${String(d.getMinutes()).padStart(
    2,
    "0"
  )}${String(d.getSeconds()).padStart(2, "0")}`;
}

function flattenTree(nodes, parentId = null, depth = 0, result = []) {
  (nodes || []).forEach((node, index) => {
    result.push({ id: node.id, label: node.label, parentId, depth, position: index });
    if (node.children?.length) {
      flattenTree(node.children, node.id, depth + 1, result);
    }
  });
  return result;
}

function buildTreeFromFlat(flat) {
  const nodesById = new Map();
  const roots = [];

  flat.forEach((i) => {
    nodesById.set(i.id, { id: i.id, label: i.label, children: [] });
  });

  flat.forEach((i) => {
    const node = nodesById.get(i.id);
    if (!i.parentId) roots.push(node);
    else nodesById.get(i.parentId)?.children.push(node);
  });

  const cleanup = (n) => {
    if (!n.children.length) delete n.children;
    else n.children.forEach(cleanup);
  };
  roots.forEach(cleanup);

  return roots;
}

function getDescendantCount(flat, index) {
  const depth = flat[index].depth;
  let count = 0;
  for (let i = index + 1; i < flat.length; i++) {
    if (flat[i].depth <= depth) break;
    count++;
  }
  return count;
}

function arrayMoveBlock(array, from, to, size) {
  const arr = [...array];
  const block = arr.splice(from, size);
  arr.splice(to, 0, ...block);
  return arr;
}

function findParentIdForDepth(flat, index, depth) {
  if (depth === 0) return null;
  for (let i = index - 1; i >= 0; i--) {
    if (flat[i].depth === depth - 1) return flat[i].id;
  }
  return null;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function mergeMenuWithShopify(menu, collections) {
  const map = new Map(collections.map((c) => [c.id, c]));

  const clean = (nodes = []) =>
    nodes
      .filter((n) => map.has(n.id))
      .map((n) => ({
        id: n.id,
        label: map.get(n.id).title,
        children: n.children ? clean(n.children) : undefined,
      }));

  const existing = new Set();
  const collect = (nodes) => {
    nodes.forEach((n) => {
      existing.add(n.id);
      n.children && collect(n.children);
    });
  };

  const result = clean(menu || []);
  collect(result);

  const appended = collections
    .filter((c) => !existing.has(c.id))
    .map((c) => ({ id: c.id, label: c.title }));

  return [...result, ...appended];
}

function flattenForSave(nodes, parentId = null, level = 0, result = []) {
  (nodes || []).forEach((node, index) => {
    result.push({ id: node.id, label: node.label, parentId, position: index, level });
    node.children && flattenForSave(node.children, node.id, level + 1, result);
  });
  return result;
}

/* ============================ SERVER ============================ */

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const versionId = url.searchParams.get("versionId");

  const res = await admin.graphql(`
    query {
      collections(first: 250) {
        nodes { id title }
      }
    }
  `);

  const json = await res.json();
  const collections = json.data.collections.nodes;

  const versions = await prisma.collectionMenuVersion.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });

  const selected =
    (versionId && versions.find((v) => String(v.id) === versionId)) ||
    versions.find((v) => v.isActive) ||
    versions[0] ||
    null;

  const baseMenu = selected?.menuJson
    ? selected.menuJson
    : collections.map((c) => ({ id: c.id, label: c.title }));

  const tree = mergeMenuWithShopify(baseMenu, collections);

  return {
    tree,
    versions,
    selectedVersion: selected
      ? { id: selected.id, versionName: selected.versionName }
      : null,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();
  const intent = fd.get("intent");

  if (intent === "build_from_magento") {
    const MAGENTO_BASE = String(await getSettingOr("magento_url", "")).trim();
    if (!MAGENTO_BASE) throw new Response("Missing Magento URL", { status: 400 });

    const res = await fetch(`${MAGENTO_BASE}/rest/V1/shopify/categories`);
    const data = await res.json();

    const maps = await prisma.productMapMagento.findMany({
      where: { shopifyCollectionId: { not: null } },
      select: { magentoCategoryId: true, shopifyCollectionId: true },
    });

    const map = new Map(
      maps.map((m) => [Number(m.magentoCategoryId), m.shopifyCollectionId])
    );

    return {
      tree: buildTreeFromMagentoCategories(data.items ?? [], map),
    };
  }

  if (intent !== "save") return {};

  const tree = JSON.parse(fd.get("treeJson") || "[]");

  await prisma.$transaction(async (tx) => {
    await tx.collectionMenuVersion.updateMany({
      where: { shop, isActive: true },
      data: { isActive: false },
    });

    await tx.collectionMenuVersion.create({
      data: {
        shop,
        versionName: buildVersionName("version"),
        menuJson: tree,
        isActive: true,
      },
    });
  });

  return { ok: true };
};

/* ============================ TREE UI ============================ */

function SortableRow({ item, isExpanded, onToggle, style }) {
  const { setNodeRef, attributes, listeners, transform, transition } =
    useSortable({ id: item.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <div style={{ height: 32, display: "flex", alignItems: "center", gap: 8 }}>
        {item.hasChildren ? (
          <span onClick={onToggle}>
            <Icon source={isExpanded ? ChevronDownIcon : ChevronRightIcon} />
          </span>
        ) : (
          <span style={{ width: 20 }} />
        )}

        <span {...attributes} {...listeners}>
          <Icon source={DragHandleIcon} />
        </span>

        <Icon source={FolderIcon} />
        <Text>{item.label}</Text>
      </div>
    </div>
  );
}

function flattenForRender(nodes, expanded, parentId = null, depth = 0, out = []) {
  nodes.forEach((n) => {
    const hasChildren = !!n.children?.length;
    out.push({
      id: n.id,
      label: n.label,
      parentId,
      depth,
      hasChildren,
      isExpanded: expanded.has(n.id),
    });
    if (hasChildren && expanded.has(n.id)) {
      flattenForRender(n.children, expanded, n.id, depth + 1, out);
    }
  });
  return out;
}

/* ============================ PAGE ============================ */

export default function CategoryPage() {
  const { tree: initialTree, versions, selectedVersion } = useLoaderData();
  const fetcher = useFetcher();
  const buildFetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const didInitExpand = useRef(false);

  const [tree, setTree] = useState(initialTree ?? []);
  const [expanded, setExpanded] = useState(new Set());
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const dragOffsetXRef = useRef(0);

  useEffect(() => {
    setTree(initialTree ?? []);
    if (!didInitExpand.current) {
      setExpanded(new Set(getExpandableIds(initialTree)));
      didInitExpand.current = true;
    }
  }, [initialTree]);

  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show("Category menu saved");
      window.location.reload();
    }
  }, [fetcher.data]);

  useEffect(() => {
    if (buildFetcher.data?.tree) {
      setTree(buildFetcher.data.tree);
      setExpanded(new Set(getExpandableIds(buildFetcher.data.tree)));
      shopify.toast.show("Magento structure applied");
    }
  }, [buildFetcher.data]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );

  const renderList = useMemo(
    () => flattenForRender(tree, expanded),
    [tree, expanded]
  );

  const visibleIds = useMemo(() => renderList.map((i) => i.id), [renderList]);

  const onSave = () =>
    fetcher.submit(
      { intent: "save", treeJson: JSON.stringify(tree) },
      { method: "POST" }
    );

  const onPickVersion = (id) => {
    const sp = new URLSearchParams(searchParams);
    sp.set("versionId", String(id));
    navigate(`?${sp.toString()}`);
    setVersionsOpen(false);
  };

  const computeProjectedDepth = (d) =>
    d + Math.round(dragOffsetXRef.current / INDENT_WIDTH);

  const onDragEnd = ({ active, over }) => {
    setActiveId(null);
    if (!over || active.id === over.id) return;

    const flat = flattenTree(tree);
    const from = flat.findIndex((i) => i.id === active.id);
    const to = flat.findIndex((i) => i.id === over.id);
    const size = 1 + getDescendantCount(flat, from);
    let moved = arrayMoveBlock(flat, from, to, size);

    const idx = moved.findIndex((i) => i.id === active.id);
    const prev = moved[idx - 1];
    const depth = clamp(
      computeProjectedDepth(moved[idx].depth),
      0,
      prev ? prev.depth + 1 : 0
    );

    moved[idx].depth = depth;
    for (let i = 0; i < moved.length; i++) {
      moved[i].parentId = findParentIdForDepth(moved, i, moved[i].depth);
    }

    setTree(buildTreeFromFlat(moved));
  };

  return (
    <Page
      title={
        selectedVersion
          ? `Category Tree — ${selectedVersion.versionName}`
          : "Category Tree"
      }
      fullWidth
      primaryAction={{
        content: "Save",
        onAction: onSave,
        loading:
          fetcher.state === "submitting" &&
          fetcher.formData?.get("intent") === "save",
      }}
      secondaryActions={[
        { content: "Versions", onAction: () => setVersionsOpen(true) },
        {
          content: "Cancel",
          destructive: true,
          onAction: () => window.location.reload(),
        },
      ]}
    >
      <Card>
        <InlineStack align="space-between" gap="200" padding="200">
          <InlineStack gap="100">
            <Button variant="plain" onClick={() => setExpanded(new Set(getExpandableIds(tree)))}>
              Expand all
            </Button>
            <Button variant="plain" onClick={() => setExpanded(new Set())}>
              Collapse all
            </Button>

            {/* build from magento */}
            <buildFetcher.Form method="post">
              <input type="hidden" name="intent" value="build_from_magento" />
              <Button
                variant="secondary"
                submit
                loading={buildFetcher.state !== "idle"}
              >
                Build from Magento
              </Button>
            </buildFetcher.Form>
          </InlineStack>

          <Badge tone="info">Indent: {INDENT_WIDTH}px</Badge>
        </InlineStack>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={(e) => setActiveId(e.active.id)}
          onDragMove={(e) => (dragOffsetXRef.current = e.delta.x)}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
            {renderList.map((item) => (
              <SortableRow
                key={item.id}
                item={item}
                isExpanded={item.isExpanded}
                onToggle={() =>
                  setExpanded((s) =>
                    new Set(s.has(item.id) ? [...s].filter((i) => i !== item.id) : [...s, item.id])
                  )
                }
                style={{
                  paddingLeft: item.depth * INDENT_WIDTH,
                  opacity: activeId === item.id ? 0.6 : 1,
                }}
              />
            ))}
          </SortableContext>
        </DndContext>
      </Card>

      <Modal open={versionsOpen} onClose={() => setVersionsOpen(false)} title="Menu Versions">
        <Modal.Section>
          <ResourceList
            items={versions}
            renderItem={(v) => (
              <ResourceItem id={String(v.id)} onClick={() => onPickVersion(v.id)}>
                <InlineStack align="space-between">
                  <InlineStack gap="200">
                    <Text fontWeight="semibold">{v.versionName}</Text>
                    {v.isActive && <Badge tone="success">Active</Badge>}
                    {selectedVersion?.id === v.id && (
                      <Badge tone="info">Selected</Badge>
                    )}
                  </InlineStack>
                  <Text tone="subdued">
                    {new Date(v.createdAt).toLocaleString()}
                  </Text>
                </InlineStack>
              </ResourceItem>
            )}
          />
        </Modal.Section>
      </Modal>
    </Page>
  );
}

/* ============================ HEADERS ============================ */

export const headers = (args) => boundary.headers(args);
