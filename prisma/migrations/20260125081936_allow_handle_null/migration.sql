-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AttributeMapMetafield" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "magentoAttributeCode" TEXT NOT NULL,
    "shopifyNamespace" TEXT NOT NULL,
    "shopifyKey" TEXT NOT NULL,
    "shopifyType" TEXT NOT NULL,
    "metaobjectHandle" TEXT,
    "metaobjectTypeId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AttributeMapMetafield" ("createdAt", "id", "magentoAttributeCode", "metaobjectHandle", "metaobjectTypeId", "shopifyKey", "shopifyNamespace", "shopifyType", "updatedAt") SELECT "createdAt", "id", "magentoAttributeCode", "metaobjectHandle", "metaobjectTypeId", "shopifyKey", "shopifyNamespace", "shopifyType", "updatedAt" FROM "AttributeMapMetafield";
DROP TABLE "AttributeMapMetafield";
ALTER TABLE "new_AttributeMapMetafield" RENAME TO "AttributeMapMetafield";
CREATE UNIQUE INDEX "AttributeMapMetafield_magentoAttributeCode_key" ON "AttributeMapMetafield"("magentoAttributeCode");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
