-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionMenuVersion" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "versionName" TEXT NOT NULL,
    "menuJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CollectionMenuVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionMapCategory" (
    "id" SERIAL NOT NULL,
    "collectionId" TEXT NOT NULL,
    "magentoCategoryId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionMapCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMapMagento" (
    "id" SERIAL NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "magentoProductId" INTEGER NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMapMagento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributeMapMetafield" (
    "id" SERIAL NOT NULL,
    "magentoAttributeCode" TEXT NOT NULL,
    "shopifyNamespace" TEXT NOT NULL,
    "shopifyKey" TEXT NOT NULL,
    "shopifyType" TEXT NOT NULL,
    "metaobjectHandle" TEXT,
    "metaobjectTypeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttributeMapMetafield_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "CollectionMenuVersion_shop_idx" ON "CollectionMenuVersion"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionMapCategory_collectionId_key" ON "CollectionMapCategory"("collectionId");

-- CreateIndex
CREATE INDEX "CollectionMapCategory_magentoCategoryId_idx" ON "CollectionMapCategory"("magentoCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapMagento_shopifyProductId_key" ON "ProductMapMagento"("shopifyProductId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapMagento_magentoProductId_key" ON "ProductMapMagento"("magentoProductId");

-- CreateIndex
CREATE INDEX "ProductMapMagento_magentoProductId_idx" ON "ProductMapMagento"("magentoProductId");

-- CreateIndex
CREATE UNIQUE INDEX "AttributeMapMetafield_magentoAttributeCode_key" ON "AttributeMapMetafield"("magentoAttributeCode");
