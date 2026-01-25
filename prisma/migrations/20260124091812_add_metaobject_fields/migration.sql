/*
  Warnings:

  - Added the required column `metaobjectHandle` to the `AttributeMapMetafield` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AttributeMapMetafield" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "magentoAttributeCode" TEXT NOT NULL,
    "shopifyNamespace" TEXT NOT NULL,
    "shopifyKey" TEXT NOT NULL,
    "shopifyType" TEXT NOT NULL,
    "metaobjectHandle" TEXT NOT NULL,
    "metaobjectTypeId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AttributeMapMetafield" ("createdAt", "id", "magentoAttributeCode", "shopifyKey", "shopifyNamespace", "shopifyType", "updatedAt") SELECT "createdAt", "id", "magentoAttributeCode", "shopifyKey", "shopifyNamespace", "shopifyType", "updatedAt" FROM "AttributeMapMetafield";
DROP TABLE "AttributeMapMetafield";
ALTER TABLE "new_AttributeMapMetafield" RENAME TO "AttributeMapMetafield";
CREATE UNIQUE INDEX "AttributeMapMetafield_magentoAttributeCode_key" ON "AttributeMapMetafield"("magentoAttributeCode");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
