-- CreateTable
CREATE TABLE "CollectionMapCategory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "collectionId" TEXT NOT NULL,
    "magentoCategoryId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "CollectionMapCategory_collectionId_key" ON "CollectionMapCategory"("collectionId");

-- CreateIndex
CREATE INDEX "CollectionMapCategory_magentoCategoryId_idx" ON "CollectionMapCategory"("magentoCategoryId");
