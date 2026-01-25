-- CreateTable
CREATE TABLE "CollectionMenuVersion" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "versionName" TEXT NOT NULL,
    "menuJson" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT false
);

-- CreateIndex
CREATE INDEX "CollectionMenuVersion_shop_idx" ON "CollectionMenuVersion"("shop");
