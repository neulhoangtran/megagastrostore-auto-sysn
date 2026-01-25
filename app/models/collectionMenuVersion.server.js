import { prisma } from "~/db.server";

export async function listMenuVersions(shop) {
  return prisma.collectionMenuVersion.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    select: { id: true, versionName: true, createdAt: true, isActive: true },
  });
}

export async function getMenuVersionById(shop, id) {
  if (!id) return null;
  const versionId = Number(id);
  if (!Number.isFinite(versionId)) return null;

  return prisma.collectionMenuVersion.findFirst({
    where: { shop, id: versionId },
    select: { id: true, versionName: true, menuJson: true, createdAt: true, isActive: true },
  });
}

export async function getActiveOrLatestMenuVersion(shop) {
  const active = await prisma.collectionMenuVersion.findFirst({
    where: { shop, isActive: true },
    orderBy: { createdAt: "desc" },
    select: { id: true, versionName: true, menuJson: true, createdAt: true, isActive: true },
  });
  if (active) return active;

  return prisma.collectionMenuVersion.findFirst({
    where: { shop },
    orderBy: { createdAt: "desc" },
    select: { id: true, versionName: true, menuJson: true, createdAt: true, isActive: true },
  });
}

export async function createMenuVersionAndSetActive({ shop, versionName, menuJson }) {
  // Set active = true cho version mới và tắt active cũ
  return prisma.$transaction(async (tx) => {
    await tx.collectionMenuVersion.updateMany({
      where: { shop, isActive: true },
      data: { isActive: false },
    });

    return tx.collectionMenuVersion.create({
      data: {
        shop,
        versionName,
        menuJson,
        isActive: true,
      },
      select: { id: true, versionName: true, createdAt: true, isActive: true },
    });
  });
}
