// Shared helpers for the inventory ledger: signup-bonus minting, manual MR
// top-ups, partial splits, and liquidation. Every entry point is designed to
// run inside a Prisma interactive transaction so callers can compose them
// safely with their own writes.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  ASSET_STATUS,
  ASSET_TYPE,
  CARD_SPECS,
  CARD_TYPE,
  MR_POINT_VALUE,
  PROCEEDS_TYPE,
  type AssetType,
  type CardType,
  type ProceedsType,
} from "@/lib/constants";

type Tx = Prisma.TransactionClient | typeof prisma;

const SUB_MERCHANT = "Amex SUB";
const TOPUP_MERCHANT = "MR top-up";

function isAmexCardType(cardType: string): cardType is "ABP" | "ABG" {
  return cardType === CARD_TYPE.ABP || cardType === CARD_TYPE.ABG;
}

/**
 * Idempotent: if the card has crossed its spend target and we haven't yet
 * minted its signup-bonus MR inventory, mint it. Returns the asset row if
 * created, otherwise null.
 *
 * "First crossing" is detected by the absence of an existing SUB transaction
 * for this card -- once minted, the asset stays in inventory regardless of
 * whether currentSpend later dips (e.g. a refund). The bonus already posted
 * to the Amex account; the ledger should reflect that permanently.
 */
export async function ensureSubMrInventory(
  tx: Tx,
  cardId: string,
): Promise<{ minted: boolean; quantity: number } | null> {
  const card = await tx.card.findUnique({ where: { id: cardId } });
  if (!card) return null;
  if (!isAmexCardType(card.type)) return null;
  if (card.spendTarget <= 0) return null;
  if (card.currentSpend < card.spendTarget) return { minted: false, quantity: 0 };

  // Bonus amount: prefer the per-card override on Card.signupBonus; fall back
  // to the spec default. This lets the user record uplifted offers (e.g. a
  // 250k targeted ABG offer) by editing the card row.
  //
  // isAmexCardType above narrowed card.type to "ABP" | "ABG", which is a
  // subset of CARD_SPECS keys, so the index access is safe at the type level.
  const cardType: "ABP" | "ABG" = card.type;
  const bonus = card.signupBonus > 0
    ? card.signupBonus
    : (CARD_SPECS[cardType]?.signupBonusMR ?? 0);
  if (bonus <= 0) return { minted: false, quantity: 0 };

  // Idempotency check: one SUB transaction per card, ever.
  const existing = await tx.transaction.findFirst({
    where: { cardId, merchant: SUB_MERCHANT },
    select: { id: true },
  });
  if (existing) return { minted: false, quantity: 0 };

  const subTxn = await tx.transaction.create({
    data: {
      cardId,
      date: new Date(),
      merchant: SUB_MERCHANT,
      amount: 0,
      notes: `Auto-minted SUB for ${cardType} (${bonus.toLocaleString()} MR)`,
      status: "RECONCILED_MS",
      reconciledAt: new Date(),
    },
  });

  await tx.inventoryAsset.create({
    data: {
      type: ASSET_TYPE.MR_POINTS,
      subType: `SUB-${cardType}`,
      quantity: bonus,
      acquisitionCost: 0,
      expectedLiquidationValue: bonus * MR_POINT_VALUE,
      sourceTransactionId: subTxn.id,
    },
  });

  return { minted: true, quantity: bonus };
}

/**
 * Manual MR top-up for non-MS spend. We don't try to mirror Amex's category
 * multipliers from Plaid (too brittle); instead the user occasionally enters
 * "I have 12,400 more MR than last time" and we record that as inventory.
 */
export async function topUpMrInventory(
  tx: Tx,
  cardId: string,
  quantity: number,
  notes?: string | null,
): Promise<{ assetId: string }> {
  if (quantity <= 0) throw new Error("Top-up quantity must be positive");
  const card = await tx.card.findUnique({ where: { id: cardId } });
  if (!card) throw new Error("Card not found");
  if (!isAmexCardType(card.type)) throw new Error("Only Amex cards earn MR");

  const txnRow = await tx.transaction.create({
    data: {
      cardId,
      date: new Date(),
      merchant: TOPUP_MERCHANT,
      amount: 0,
      notes: notes ?? `Manual MR top-up: ${quantity.toLocaleString()}`,
      status: "RECONCILED_MS",
      reconciledAt: new Date(),
    },
  });

  const asset = await tx.inventoryAsset.create({
    data: {
      type: ASSET_TYPE.MR_POINTS,
      subType: `TOPUP-${card.type}`,
      quantity,
      acquisitionCost: 0,
      expectedLiquidationValue: quantity * MR_POINT_VALUE,
      sourceTransactionId: txnRow.id,
    },
  });

  return { assetId: asset.id };
}

// ---------------------------------------------------------------------------
// Liquidation
// ---------------------------------------------------------------------------

export interface LiquidateOneInput {
  assetId: string;
  /** Quantity to liquidate; if equal to or > asset.quantity, full liquidation. */
  quantity?: number;
  realizedRevenue: number;
  buyer: string;
  proceedsType?: ProceedsType;
  date?: Date;
  notes?: string | null;
}

export interface LiquidateBulkInput {
  type: AssetType;
  /** Optional filter; e.g. "KS-4x" to only drain 4x runs. */
  subTypeStartsWith?: string;
  quantity: number;
  realizedRevenue: number;
  buyer: string;
  proceedsType?: ProceedsType;
  date?: Date;
  notes?: string | null;
}

interface LiquidationLineSummary {
  assetId: string;
  liquidationEventId: string;
  quantity: number;
  revenue: number;
  profit: number;
}

/**
 * Split a HELD asset into two rows so we can liquidate part of it. The
 * `quantity` argument is the size of the *first* (head) row -- it's the
 * piece you're about to sell. Cost basis and expected value are pro-rated.
 *
 * Returns the head asset (still HELD; caller flips to LIQUIDATED).
 */
async function splitAsset(
  tx: Prisma.TransactionClient,
  assetId: string,
  quantity: number,
) {
  const original = await tx.inventoryAsset.findUnique({ where: { id: assetId } });
  if (!original) throw new Error(`Asset ${assetId} not found`);
  if (original.status === ASSET_STATUS.LIQUIDATED) {
    throw new Error(`Asset ${assetId} already liquidated`);
  }
  if (quantity <= 0 || quantity > original.quantity) {
    throw new Error(
      `Invalid split quantity ${quantity} for asset of size ${original.quantity}`,
    );
  }
  if (quantity === original.quantity) return original;

  const ratio = quantity / original.quantity;
  const headCost = original.acquisitionCost * ratio;
  const headExpected = original.expectedLiquidationValue * ratio;

  // Head: the chunk being sold. Tail: the leftover, stays HELD.
  const head = await tx.inventoryAsset.update({
    where: { id: original.id },
    data: {
      quantity,
      acquisitionCost: headCost,
      expectedLiquidationValue: headExpected,
    },
  });
  await tx.inventoryAsset.create({
    data: {
      type: original.type,
      subType: original.subType,
      status: original.status,
      quantity: original.quantity - quantity,
      acquisitionCost: original.acquisitionCost - headCost,
      expectedLiquidationValue: original.expectedLiquidationValue - headExpected,
      acquiredDate: original.acquiredDate,
      sourceTransactionId: original.sourceTransactionId,
    },
  });
  return head;
}

async function liquidateAssetRow(
  tx: Prisma.TransactionClient,
  assetId: string,
  revenue: number,
  buyer: string,
  proceedsType: ProceedsType,
  date: Date,
  notes: string | null,
): Promise<LiquidationLineSummary> {
  const asset = await tx.inventoryAsset.findUnique({ where: { id: assetId } });
  if (!asset) throw new Error(`Asset ${assetId} not found`);
  if (asset.status === ASSET_STATUS.LIQUIDATED) {
    throw new Error(`Asset ${assetId} already liquidated`);
  }
  const days = Math.max(
    0,
    Math.floor(
      (date.getTime() - asset.acquiredDate.getTime()) / (1000 * 60 * 60 * 24),
    ),
  );
  const profit = revenue - asset.acquisitionCost;

  const event = await tx.liquidationEvent.create({
    data: {
      inventoryAssetId: asset.id,
      date,
      buyer,
      proceedsType,
      realizedRevenue: revenue,
      profit,
      daysToLiquidation: days,
      notes: notes ?? null,
    },
  });
  await tx.inventoryAsset.update({
    where: { id: asset.id },
    data: { status: ASSET_STATUS.LIQUIDATED },
  });
  return {
    assetId: asset.id,
    liquidationEventId: event.id,
    quantity: asset.quantity,
    revenue,
    profit,
  };
}

export async function liquidateOne(
  input: LiquidateOneInput,
): Promise<LiquidationLineSummary[]> {
  const date = input.date ?? new Date();
  const proceedsType = input.proceedsType ?? PROCEEDS_TYPE.CASH;
  return prisma.$transaction(async (tx) => {
    const asset = await tx.inventoryAsset.findUnique({
      where: { id: input.assetId },
    });
    if (!asset) throw new Error("Asset not found");
    if (asset.status === ASSET_STATUS.LIQUIDATED) {
      throw new Error("Asset already liquidated");
    }
    const qty = input.quantity ?? asset.quantity;
    if (qty <= 0) throw new Error("Quantity must be positive");
    if (qty > asset.quantity) {
      throw new Error(
        `Quantity ${qty} exceeds asset size ${asset.quantity}`,
      );
    }
    const head = await splitAsset(tx, asset.id, qty);
    const line = await liquidateAssetRow(
      tx,
      head.id,
      input.realizedRevenue,
      input.buyer,
      proceedsType,
      date,
      input.notes ?? null,
    );
    return [line];
  });
}

/**
 * FIFO drain: walk HELD assets of the given type (oldest acquiredDate first),
 * splitting the last one if necessary, until `quantity` units have been
 * liquidated. Revenue is allocated pro-rata across the sold units.
 */
export async function liquidateBulk(
  input: LiquidateBulkInput,
): Promise<LiquidationLineSummary[]> {
  const date = input.date ?? new Date();
  const proceedsType = input.proceedsType ?? PROCEEDS_TYPE.CASH;
  if (input.quantity <= 0) throw new Error("Quantity must be positive");
  if (input.realizedRevenue < 0) throw new Error("Revenue cannot be negative");

  return prisma.$transaction(async (tx) => {
    const candidates = await tx.inventoryAsset.findMany({
      where: {
        type: input.type,
        status: { not: ASSET_STATUS.LIQUIDATED },
        ...(input.subTypeStartsWith
          ? { subType: { startsWith: input.subTypeStartsWith } }
          : {}),
      },
      orderBy: { acquiredDate: "asc" },
    });
    const totalAvailable = candidates.reduce((s, a) => s + a.quantity, 0);
    if (input.quantity > totalAvailable + 1e-6) {
      throw new Error(
        `Requested ${input.quantity} but only ${totalAvailable} ${input.type} held`,
      );
    }

    const lines: LiquidationLineSummary[] = [];
    let remaining = input.quantity;
    for (const asset of candidates) {
      if (remaining <= 1e-9) break;
      const take = Math.min(asset.quantity, remaining);
      const ratio = take / input.quantity;
      const lineRevenue = input.realizedRevenue * ratio;
      const head = await splitAsset(tx, asset.id, take);
      const line = await liquidateAssetRow(
        tx,
        head.id,
        lineRevenue,
        input.buyer,
        proceedsType,
        date,
        input.notes ?? null,
      );
      lines.push(line);
      remaining -= take;
    }
    return lines;
  });
}
