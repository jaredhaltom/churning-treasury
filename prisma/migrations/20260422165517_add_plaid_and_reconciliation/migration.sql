/*
  Warnings:

  - Added the required column `updatedAt` to the `Transaction` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "PlaidItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "institutionId" TEXT,
    "institutionName" TEXT,
    "accessToken" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "cursor" TEXT,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Card" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "nickname" TEXT,
    "openDate" DATETIME NOT NULL,
    "spendTarget" REAL NOT NULL DEFAULT 0,
    "currentSpend" REAL NOT NULL DEFAULT 0,
    "cooldownDays" INTEGER NOT NULL DEFAULT 91,
    "signupBonus" INTEGER NOT NULL DEFAULT 0,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "plaidItemId" TEXT,
    "plaidAccountId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Card_plaidItemId_fkey" FOREIGN KEY ("plaidItemId") REFERENCES "PlaidItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Card" ("closed", "cooldownDays", "createdAt", "currentSpend", "id", "nickname", "openDate", "signupBonus", "spendTarget", "type", "updatedAt") SELECT "closed", "cooldownDays", "createdAt", "currentSpend", "id", "nickname", "openDate", "signupBonus", "spendTarget", "type", "updatedAt" FROM "Card";
DROP TABLE "Card";
ALTER TABLE "new_Card" RENAME TO "Card";
CREATE INDEX "Card_type_openDate_idx" ON "Card"("type", "openDate");
CREATE INDEX "Card_plaidItemId_idx" ON "Card"("plaidItemId");
CREATE TABLE "new_Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cardId" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'MANUAL_UNMATCHED',
    "category" TEXT,
    "plaidTransactionId" TEXT,
    "plaidAccountId" TEXT,
    "reconciledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Transaction_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Transaction" ("amount", "cardId", "createdAt", "date", "id", "merchant", "notes") SELECT "amount", "cardId", "createdAt", "date", "id", "merchant", "notes" FROM "Transaction";
DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";
CREATE UNIQUE INDEX "Transaction_plaidTransactionId_key" ON "Transaction"("plaidTransactionId");
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");
CREATE INDEX "Transaction_cardId_idx" ON "Transaction"("cardId");
CREATE INDEX "Transaction_status_idx" ON "Transaction"("status");
CREATE INDEX "Transaction_plaidAccountId_idx" ON "Transaction"("plaidAccountId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "PlaidItem_itemId_key" ON "PlaidItem"("itemId");
