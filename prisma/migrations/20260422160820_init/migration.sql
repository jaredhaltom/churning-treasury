-- CreateTable
CREATE TABLE "Card" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "nickname" TEXT,
    "openDate" DATETIME NOT NULL,
    "spendTarget" REAL NOT NULL DEFAULT 0,
    "currentSpend" REAL NOT NULL DEFAULT 0,
    "cooldownDays" INTEGER NOT NULL DEFAULT 91,
    "signupBonus" INTEGER NOT NULL DEFAULT 0,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cardId" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transaction_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InventoryAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "subType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "quantity" REAL NOT NULL,
    "acquisitionCost" REAL NOT NULL,
    "expectedLiquidationValue" REAL NOT NULL,
    "acquiredDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceTransactionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InventoryAsset_sourceTransactionId_fkey" FOREIGN KEY ("sourceTransactionId") REFERENCES "Transaction" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LiquidationEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "inventoryAssetId" TEXT NOT NULL,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "buyer" TEXT NOT NULL,
    "realizedRevenue" REAL NOT NULL,
    "profit" REAL NOT NULL,
    "daysToLiquidation" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LiquidationEvent_inventoryAssetId_fkey" FOREIGN KEY ("inventoryAssetId") REFERENCES "InventoryAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Card_type_openDate_idx" ON "Card"("type", "openDate");

-- CreateIndex
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");

-- CreateIndex
CREATE INDEX "Transaction_cardId_idx" ON "Transaction"("cardId");

-- CreateIndex
CREATE INDEX "InventoryAsset_type_status_idx" ON "InventoryAsset"("type", "status");

-- CreateIndex
CREATE INDEX "InventoryAsset_status_acquiredDate_idx" ON "InventoryAsset"("status", "acquiredDate");

-- CreateIndex
CREATE UNIQUE INDEX "LiquidationEvent_inventoryAssetId_key" ON "LiquidationEvent"("inventoryAssetId");

-- CreateIndex
CREATE INDEX "LiquidationEvent_date_idx" ON "LiquidationEvent"("date");
