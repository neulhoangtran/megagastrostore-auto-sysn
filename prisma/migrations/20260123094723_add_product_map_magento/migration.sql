-- CreateTable
CREATE TABLE "ProductMapMagento" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopifyProductId" TEXT NOT NULL,
    "magentoProductId" INTEGER NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapMagento_shopifyProductId_key" ON "ProductMapMagento"("shopifyProductId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapMagento_magentoProductId_key" ON "ProductMapMagento"("magentoProductId");

-- CreateIndex
CREATE INDEX "ProductMapMagento_magentoProductId_idx" ON "ProductMapMagento"("magentoProductId");
