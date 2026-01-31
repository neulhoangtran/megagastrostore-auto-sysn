import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Button } from "@shopify/polaris";
import { getSettingOr } from "../utils/settings";
import {
  useLoaderData,
  useFetcher,
  useNavigate,
  useSearchParams,
} from "react-router";

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

/* ===================================================================== */
/* ============================ CONFIG ================================== */
/* ===================================================================== */

const INDENT_WIDTH = 24; // kéo sang phải mỗi 24px = +1 level

/* ===================================================================== */
/* ============================ HELPERS ================================= */
/* ===================================================================== */

function buildTreeFromMagentoCategories(categories, magentoToShopifyMap) {
  const nodesByMagentoId = new Map();

  // Step 1: create node
  categories.forEach((cat) => {
    const shopifyCollectionId = magentoToShopifyMap.get(
      Number(cat.category_id)
    );

    if (!shopifyCollectionId) return; // skip chưa map

    nodesByMagentoId.set(Number(cat.category_id), {
      id: shopifyCollectionId,
      label: cat.name,
      parentMagentoId: Number(cat.parent_id),
      children: [],
    });
  });

  // Step 2: attach parent-child
  const roots = [];

  nodesByMagentoId.forEach((node) => {
    const parent = nodesByMagentoId.get(node.parentMagentoId);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });

  // Step 3: clean output
  const clean = (n) => ({
    id: n.id,
    label: n.label,
    ...(n.children.length ? { children: n.children.map(clean) } : {}),
  });

  return roots.map(clean);
}


function getExpandableIds(nodes, set = new Set()) {
  (nodes || []).forEach((n) => {
    if (n.children?.length) set.add(n.id);
    if (n.children?.length) getExpandableIds(n.children, set);
  });
  return set;
}

function buildVersionName(prefix = "version") {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${prefix}-${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

/**
 * Flatten nested tree -> array with depth/parentId
 * Node: {id,label,children?}
 */
function flattenTree(nodes, parentId = null, depth = 0, result = []) {
  (nodes || []).forEach((node, index) => {
    result.push({
      id: node.id,
      label: node.label,
      parentId,
      depth,
      position: index,
    });
    if (node.children?.length) {
      flattenTree(node.children, node.id, depth + 1, result);
    }
  });
  return result;
}

/**
 * Build nested tree from flat array (ordered, with parentId+depth)
 */
function buildTreeFromFlat(flat) {
  const nodesById = new Map();
  const roots = [];

  // create nodes
  flat.forEach((item) => {
    nodesById.set(item.id, { id: item.id, label: item.label, children: [] });
  });

  // attach
  flat.forEach((item) => {
    const node = nodesById.get(item.id);
    if (!item.parentId) {
      roots.push(node);
    } else {
      const parent = nodesById.get(item.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node); // fallback
    }
  });

  // cleanup empty children
  const cleanup = (n) => {
    if (!n.children?.length) {
      delete n.children;
      return;
    }
    n.children.forEach(cleanup);
  };
  roots.forEach(cleanup);

  return roots;
}

/**
 * Get descendants of an item in flat list (based on depth)
 * So when dragging parent, we can move its subtree as a block
 */
function getDescendantCount(flat, index) {
  const depth = flat[index].depth;
  let count = 0;
  for (let i = index + 1; i < flat.length; i++) {
    if (flat[i].depth <= depth) break;
    count++;
  }
  return count;
}

/**
 * Move a block (item + its descendants) to a new index
 */
function arrayMoveBlock(array, fromIndex, toIndex, blockSize) {
  const newArray = [...array];
  const block = newArray.splice(fromIndex, blockSize);
  newArray.splice(toIndex, 0, ...block);
  return newArray;
}

/**
 * Find the parentId if an item ends up with a given depth at a given index
 */
function findParentIdForDepth(flat, index, depth) {
  if (depth === 0) return null;

  // scan upward to find nearest item with depth = depth-1
  for (let i = index - 1; i >= 0; i--) {
    if (flat[i].depth === depth - 1) return flat[i].id;
  }
  return null;
}

/**
 * Clamp between min/max
 */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Merge saved menu JSON with Shopify live collections
 * - deleted -> remove
 * - new -> append to end (root)
 * - label always from Shopify
 */
function mergeMenuWithShopify(menu, collections) {
  const map = new Map((collections || []).map((c) => [c.id, c]));

  const clean = (nodes = []) =>
    nodes
      .filter((n) => n?.id && map.has(n.id))
      .map((n) => ({
        id: n.id,
        label: map.get(n.id).title,
        children: n.children ? clean(n.children) : undefined,
      }));

  const collectIds = (nodes, set = new Set()) => {
    (nodes || []).forEach((n) => {
      set.add(n.id);
      if (n.children) collectIds(n.children, set);
    });
    return set;
  };

  let result = clean(menu || []);
  const existingIds = collectIds(result);

  const appended = (collections || [])
    .filter((c) => !existingIds.has(c.id))
    .map((c) => ({ id: c.id, label: c.title }));

  return [...result, ...appended];
}

/**
 * Your old “print order” format (includes parentId)
 */
function flattenForSave(nodes, parentId = null, level = 0, result = []) {
  (nodes || []).forEach((node, index) => {
    result.push({
      id: node.id,
      label: node.label,
      parentId,
      position: index,
      level,
    });
    if (node.children?.length) {
      flattenForSave(node.children, node.id, level + 1, result);
    }
  });
  return result;
}

/* ===================================================================== */
/* ============================ SERVER ================================== */
/* ===================================================================== */

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const versionId = url.searchParams.get("versionId");

  // 1) Fetch Shopify collections
  const response = await admin.graphql(`
    query {
      collections(first: 250) {
        nodes { id title }
      }
    }
  `);

  const json = await response.json();
  const collections =
    json?.data?.collections?.nodes?.map((c) => ({ id: c.id, title: c.title })) ??
    [];

  // 2) Read versions
  const versions = await prisma.collectionMenuVersion.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });

  // 3) Pick selected version
  let selected =
    (versionId
      ? versions.find((v) => String(v.id) === String(versionId))
      : null) ||
    versions.find((v) => v.isActive) ||
    versions[0] ||
    null;

  // 4) Base menu (from version or from Shopify list)
  const baseMenu = selected?.menuJson
    ? selected.menuJson
    : collections.map((c) => ({ id: c.id, label: c.title }));

  // 5) Merge
  const tree = mergeMenuWithShopify(baseMenu, collections);

  return {
    tree,
    versions: versions.map((v) => ({
      id: v.id,
      versionName: v.versionName,
      createdAt: v.createdAt,
      isActive: v.isActive,
    })),
    selectedVersion: selected
      ? { id: selected.id, versionName: selected.versionName }
      : null,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent");
  const intentsNeedMagento = new Set(["fetch", "sync", "resync", "sync_products", "build_from_magento"]);
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

  if (intent === "build_from_magento") {
    const MAGENTO_BASE = String(await getSettingOr("magento_url", "")).trim();
    if (!MAGENTO_BASE) {
      throw new Response("Missing Magento URL", { status: 400 });
    }

    // 1) Fetch Magento categories
    const res = await fetch(`${MAGENTO_BASE}/rest/V1/shopify/categories`);
    if (!res.ok) {
      throw new Response("Failed to fetch Magento categories", { status: 500 });
    }

    const data = await res.json();
    const categories = data.items ?? [];

    // 2) Load mapping Magento → Shopify collection
    const mappings = await prisma.collectionMapCategory.findMany({
      select: {
        magentoCategoryId: true,
        collectionId: true,
      },
    });

    const magentoToShopifyMap = new Map(
      mappings.map((m) => [
        Number(m.magentoCategoryId),
        m.collectionId,
      ])
    );


    // 3) Build tree (UI only)
    const tree = buildTreeFromMagentoCategories(
      categories,
      magentoToShopifyMap
    );

    return { tree };
  }

  if (intent !== "save") return {};

  const tree = JSON.parse(formData.get("treeJson") || "[]");

  // Requirement: print current order WITH parentId
  // console.log("SAVE CATEGORY ORDER:", flattenForSave(tree));

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

/* ===================================================================== */
/* ============================ TREE UI ================================= */
/* ===================================================================== */

function SortableRow({
  item,
  isExpanded,
  onToggle,
  style,
}) {
  const { setNodeRef, attributes, listeners, transform, transition } =
    useSortable({ id: item.id });

  const rowStyle = {
    ...style,
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const hasChildren = item.hasChildren;

  return (
    <div ref={setNodeRef} style={rowStyle}>
      <div style={{ height: 32, display: "flex", alignItems: "center", gap: 8 }}>
        {hasChildren ? (
          <span onClick={onToggle} style={{ cursor: "pointer" }}>
            <Icon source={isExpanded ? ChevronDownIcon : ChevronRightIcon} />
          </span>
        ) : (
          <span style={{ width: 20 }} />
        )}

        <span {...attributes} {...listeners} style={{ cursor: "grab" }}>
          <Icon source={DragHandleIcon} />
        </span>

        <span style={{ display: "flex" }}>
          <Icon source={FolderIcon} />
        </span>

        <Text as="span">{item.label}</Text>
      </div>
    </div>
  );
}

/**
 * Flatten tree for rendering with expanded/collapsed
 */
function flattenForRender(nodes, expandedSet, parentId = null, depth = 0, out = []) {
  (nodes || []).forEach((node) => {
    const children = node.children || [];
    const hasChildren = children.length > 0;
    out.push({
      id: node.id,
      label: node.label,
      parentId,
      depth,
      hasChildren,
      isExpanded: expandedSet.has(node.id),
    });

    if (hasChildren && expandedSet.has(node.id)) {
      flattenForRender(children, expandedSet, node.id, depth + 1, out);
    }
  });
  return out;
}

/* ===================================================================== */
/* ============================ PAGE ==================================== */
/* ===================================================================== */

export default function CategoryPage() {
  const loaderData = useLoaderData();
  const fetcher = useFetcher();
  const magentoFetcher = useFetcher(); 
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const didInitExpand = useRef(false);
  const { tree: initialTree, versions, selectedVersion } = loaderData;

  // Tree state (nested)
  const [tree, setTree] = useState(initialTree ?? []);

  // Expand/collapse state
  const [expanded, setExpanded] = useState(() => new Set());

  // Versions UI
  const [versionsOpen, setVersionsOpen] = useState(false);

  // Drag state
  const [activeId, setActiveId] = useState(null);
  const dragOffsetXRef = useRef(0);

  useEffect(() => {
    setTree(initialTree ?? []);

    if (!didInitExpand.current) {
      setExpanded(new Set(getExpandableIds(initialTree ?? [])));
      didInitExpand.current = true;
    }
  }, [initialTree]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    })
  );

  const isSaving =
    fetcher.state === "submitting" &&
    fetcher.formData?.get("intent") === "save";

  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show("Category menu saved");
      // reload to show new active version name if needed
      // window.location.reload();
    }
  }, [fetcher.data?.ok, shopify]);

  useEffect(() => {
    if (
      magentoFetcher.state === "idle" &&
      magentoFetcher.data?.tree
    ) {
      setTree(magentoFetcher.data.tree); // chỉ set UI
      setExpanded(new Set(getExpandableIds(magentoFetcher.data.tree)));
      shopify.toast.show("Magento structure applied");
    }
  }, [magentoFetcher.state, magentoFetcher.data]);

  const onSave = () => {
    
    fetcher.submit(
      {
        intent: "save",
        treeJson: JSON.stringify(tree),
      },
      { method: "POST" }
    );
  };

  const expandAll = () => {
    const ids = getExpandableIds(tree);
    setExpanded(new Set(ids));
  };

  const collapseAll = () => {
    setExpanded(new Set());
  };

  const toggleExpand = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onPickVersion = (id) => {
    const sp = new URLSearchParams(searchParams);
    sp.set("versionId", String(id));
    navigate(`?${sp.toString()}`);
    setVersionsOpen(false);
  };

  // Render list (flat, respects expand/collapse)
  const renderList = useMemo(() => {
    return flattenForRender(tree, expanded);
  }, [tree, expanded]);

  const visibleIds = useMemo(() => renderList.map((x) => x.id), [renderList]);

  // Drag projection: compute new depth based on horizontal drag offset
  const computeProjectedDepth = (currentDepth) => {
    const deltaDepth = Math.round(dragOffsetXRef.current / INDENT_WIDTH);
    return currentDepth + deltaDepth;
  };

  // Helpers to rebuild nested tree from a "flat list with depth/parentId"
  const buildFlatWithParentsFromRender = (flatRender) => {
    // flatRender already has depth & parentId for visible nodes only.
    // But collapsed nodes are hidden; to allow correct nesting for hidden subtree,
    // we will operate on FULL flat from the nested tree (not only renderList).
    // So for DnD we actually flatten FULL tree (not respecting collapse),
    // then we can preserve hidden subtree.
    const fullFlat = flattenTree(tree); // includes ALL descendants always
    return fullFlat;
  };

  const onDragStart = (event) => {
    setActiveId(event.active?.id ?? null);
    dragOffsetXRef.current = 0;
  };

  const onDragMove = (event) => {
    // accumulate x delta for depth projection
    dragOffsetXRef.current = event.delta?.x ?? 0;
  };

  const onDragEnd = (event) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over || active.id === over.id) return;

    // Work on FULL flat tree (includes collapsed children too)
    const fullFlat = flattenTree(tree);

    const fromIndex = fullFlat.findIndex((x) => x.id === active.id);
    const overIndex = fullFlat.findIndex((x) => x.id === over.id);
    if (fromIndex < 0 || overIndex < 0) return;

    // Move as a block (include descendants)
    const blockSize = 1 + getDescendantCount(fullFlat, fromIndex);

    // When moving down past itself, target index needs adjustment
    const toIndex =
      overIndex > fromIndex ? overIndex - (blockSize - 1) : overIndex;

    let moved = arrayMoveBlock(fullFlat, fromIndex, toIndex, blockSize);

    // Now compute projected depth for the root of the moved block
    const movedIndex = moved.findIndex((x) => x.id === active.id);
    const currentDepth = moved[movedIndex].depth;

    // Max depth cannot exceed previous item's depth + 1
    const prev = moved[movedIndex - 1];
    const maxDepth = prev ? prev.depth + 1 : 0;

    // Min depth is 0
    const minDepth = 0;

    const projected = clamp(computeProjectedDepth(currentDepth), minDepth, maxDepth);

    // Apply new depth to the moved root
    moved[movedIndex] = {
      ...moved[movedIndex],
      depth: projected,
    };

    // Also adjust depths of its descendants relative to root depth change
    const depthDelta = projected - currentDepth;
    for (let i = movedIndex + 1; i < movedIndex + blockSize; i++) {
      moved[i] = {
        ...moved[i],
        depth: clamp(moved[i].depth + depthDelta, 0, 99),
      };
    }

    // Recompute parentId for moved root based on depth
    const newParentId = findParentIdForDepth(moved, movedIndex, projected);
    moved[movedIndex] = { ...moved[movedIndex], parentId: newParentId };

    // Recompute parentId for moved descendants based on depth scanning
    // This is important to ensure correct tree building
    for (let i = movedIndex + 1; i < movedIndex + blockSize; i++) {
      const d = moved[i].depth;
      moved[i] = {
        ...moved[i],
        parentId: findParentIdForDepth(moved, i, d),
      };
    }

    // Also recompute parentId for items AFTER moved block whose parent chain may shift
    // (safe + keeps correctness)
    for (let i = 0; i < moved.length; i++) {
      if (i >= movedIndex && i < movedIndex + blockSize) continue;
      const d = moved[i].depth;
      moved[i] = {
        ...moved[i],
        parentId: findParentIdForDepth(moved, i, d),
      };
    }

    // Finally build nested tree from flat
    const newTree = buildTreeFromFlat(moved);
    setTree(newTree);
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
        loading: isSaving,
      }}
      secondaryActions={[
        {
          content: "Versions",
          onAction: () => setVersionsOpen(true),
        },
        {
          content: "Cancel",
          destructive: true,
          onAction: () => window.location.reload(),
        },
      ]}
    >
      <Card>
        <div style={{ padding: 12 }}>
          <InlineStack align="space-between">
            <InlineStack gap="200" align="center">
              <Text as="span" variant="bodyMd">
                Drag left/right to change level (nesting). Drag up/down to reorder.
              </Text>

              <InlineStack gap="100">
                <Button variant="plain" onClick={expandAll}>
                  Expand all
                </Button>

                <Button variant="plain" onClick={collapseAll}>
                  Collapse all
                </Button>

                <magentoFetcher.Form method="post">
                  <input type="hidden" name="intent" value="build_from_magento" />
                  <Button
                    variant="secondary"
                    submit
                    loading={magentoFetcher.state !== "idle"}
                    disabled={magentoFetcher.state !== "idle"}
                  >
                    Build from Magento
                  </Button>
                </magentoFetcher.Form>
              </InlineStack>
            </InlineStack>

            <Badge tone="info">Indent: {INDENT_WIDTH}px</Badge>
          </InlineStack>
        </div>

        <div style={{ padding: 12 }}>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={onDragStart}
            onDragMove={onDragMove}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
              {renderList.map((item) => (
                <SortableRow
                  key={item.id}
                  item={item}
                  isExpanded={item.isExpanded}
                  onToggle={() => toggleExpand(item.id)}
                  style={{
                    paddingLeft: item.depth * INDENT_WIDTH,
                    opacity: activeId === item.id ? 0.6 : 1,
                  }}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </Card>

      <Modal
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        title="Menu Versions"
      >
        <Modal.Section>
          <ResourceList
            items={versions ?? []}
            renderItem={(item) => (
              <ResourceItem
                id={String(item.id)}
                onClick={() => onPickVersion(item.id)}
              >
                <InlineStack align="space-between">
                  <InlineStack gap="200" align="center">
                    <Text fontWeight="semibold">{item.versionName}</Text>
                    {item.isActive && <Badge tone="success">Active</Badge>}
                    {selectedVersion?.id === item.id && (
                      <Badge tone="info">Selected</Badge>
                    )}
                  </InlineStack>
                  <Text tone="subdued">
                    {new Date(item.createdAt).toLocaleString()}
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

/* ===================================================================== */
/* ============================ HEADERS ================================= */
/* ===================================================================== */

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
