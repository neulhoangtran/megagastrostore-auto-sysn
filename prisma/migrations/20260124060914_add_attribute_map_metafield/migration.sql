-- CreateTable
CREATE TABLE "AttributeMapMetafield" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "magentoAttributeCode" TEXT NOT NULL,
    "shopifyNamespace" TEXT NOT NULL,
    "shopifyKey" TEXT NOT NULL,
    "shopifyType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AttributeMapMetafield_magentoAttributeCode_key" ON "AttributeMapMetafield"("magentoAttributeCode");
