import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/transactions/reconcile
 *
 * The Inbox's only write path. Given one Plaid-synced transaction id, the
 * user picks one of three actions:
 *
 *   - "mark_non_ms"  : This was regular spend (groceries, gas, whatever).
 *                      It still counts toward the card's MSR; it just
 *                      doesn't produce any inventory.
 *
 *   - "link_manual"  : Link this Plaid charge to an existing manual entry
 *                      (identified by manualTransactionId). The manual
 *                      entry becomes the authoritative row: it absorbs the
 *                      Plaid txn id + true charge amount, and the Plaid row
 *                      gets deleted. InventoryAssets already on the manual
 *                      entry stay attached.
 *
 *   - "log_new_ms"   : Create a fresh MS inventory event from this Plaid
 *                      charge (shortcut when the manual form was skipped).
 *                      Delegates to /api/king-soopers-run logic inline.
 *                      Optional face-value override lets the user split a
 *                      mixed charge (e.g. $523 = $500 GC + $23 groceries).
 *
 *   - "ignore"       : User explicitly says "don't count this for MSR"
 *                      (IGNORED_PAYMENT status). Reserved for edge cases —
 *                      payments are already auto-classified during sync.
 */

import {
  BBY_LIQUIDATION_RATE_MID,
  CARD_TYPE,
  FUEL_POINT_VALUE_MID,
  KINGSOOPERS_DEFAULT_FUEL_MULTIPLIER,
  splitKingSoopersRun,
  type CardType,
} from "@/lib/constants";
import { ensureSubMrInventory } from "@/lib/inventory-ops";

const KNOWN_CARD_TYPES = new Set<string>([
  CARD_TYPE.ABP,
  CARD_TYPE.ABG,
  CARD_TYPE.VENMO,
  CARD_TYPE.OTHER,
]);

const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("mark_non_ms"),
    transactionId: z.string().min(1),
  }),
  z.object({
    action: z.literal("ignore"),
    transactionId: z.string().min(1),
  }),
  z.object({
    action: z.literal("link_manual"),
    transactionId: z.string().min(1),
    manualTransactionId: z.string().min(1),
  }),
  z.object({
    action: z.literal("log_new_ms"),
    transactionId: z.string().min(1),
    faceValue: z.number().positive(),
    fuelMultiplier: z.number().positive().max(10).optional(),
    fuelRate: z.number().positive().max(100).optional(),
    liquidationRate: z.number().positive().max(100).optional(),
  }),
]);

function normalizeFuelRate(input?: number): number {
  if (input === undefined) return FUEL_POINT_VALUE_MID;
  return input >= 1 ? input / 1000 : input;
}

function normalizeLiquidationRate(input?: number): number {
  if (input === undefined) return BBY_LIQUIDATION_RATE_MID;
  return input > 1 ? input / 100 : input;
}

async function recomputeCurrentSpend(cardId: string) {
  const agg = await prisma.transaction.aggregate({
    where: {
      cardId,
      plaidTransactionId: { not: null },
      status: { not: "IGNORED_PAYMENT" },
      amount: { gt: 0 },
    },
    _sum: { amount: true },
  });
  await prisma.card.update({
    where: { id: cardId },
    data: { currentSpend: agg._sum.amount ?? 0 },
  });
  // Auto-mint SUB inventory if this card just crossed its target.
  await ensureSubMrInventory(prisma, cardId);
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const plaid = await prisma.transaction.findUnique({
    where: { id: parsed.data.transactionId },
  });
  if (!plaid) {
    return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
  }
  if (!plaid.plaidTransactionId) {
    return NextResponse.json(
      { error: "Only Plaid-derived transactions can be reconciled here." },
      { status: 400 },
    );
  }

  switch (parsed.data.action) {
    case "mark_non_ms": {
      await prisma.transaction.update({
        where: { id: plaid.id },
        data: { status: "RECONCILED_NON_MS", reconciledAt: new Date() },
      });
      return NextResponse.json({ ok: true });
    }

    case "ignore": {
      await prisma.transaction.update({
        where: { id: plaid.id },
        data: { status: "IGNORED_PAYMENT", reconciledAt: new Date() },
      });
      await recomputeCurrentSpend(plaid.cardId);
      return NextResponse.json({ ok: true });
    }

    case "link_manual": {
      const manual = await prisma.transaction.findUnique({
        where: { id: parsed.data.manualTransactionId },
      });
      if (!manual) {
        return NextResponse.json({ error: "Manual entry not found" }, { status: 404 });
      }
      if (manual.plaidTransactionId) {
        return NextResponse.json(
          { error: "That manual entry is already linked to a Plaid transaction." },
          { status: 409 },
        );
      }
      if (manual.cardId !== plaid.cardId) {
        return NextResponse.json(
          { error: "Card mismatch between Plaid charge and manual entry." },
          { status: 409 },
        );
      }

      await prisma.$transaction(async (tx) => {
        // The manual row becomes the authoritative one: it keeps its
        // InventoryAsset children and absorbs the Plaid charge metadata.
        await tx.transaction.update({
          where: { id: manual.id },
          data: {
            amount: plaid.amount,
            date: plaid.date,
            merchant: plaid.merchant,
            plaidTransactionId: plaid.plaidTransactionId,
            plaidAccountId: plaid.plaidAccountId,
            category: plaid.category,
            status: "RECONCILED_MS",
            reconciledAt: new Date(),
          },
        });
        await tx.transaction.delete({ where: { id: plaid.id } });
      });
      await recomputeCurrentSpend(plaid.cardId);
      return NextResponse.json({ ok: true });
    }

    case "log_new_ms": {
      const card = await prisma.card.findUnique({ where: { id: plaid.cardId } });
      if (!card) {
        return NextResponse.json({ error: "Linked card not found" }, { status: 404 });
      }
      const cardType: CardType = KNOWN_CARD_TYPES.has(card.type)
        ? (card.type as CardType)
        : CARD_TYPE.OTHER;

      const split = splitKingSoopersRun({
        dollars: parsed.data.faceValue,
        cardType,
        fuelRate: normalizeFuelRate(parsed.data.fuelRate),
        fuelMultiplier:
          parsed.data.fuelMultiplier ?? KINGSOOPERS_DEFAULT_FUEL_MULTIPLIER,
        liquidationRate: normalizeLiquidationRate(parsed.data.liquidationRate),
      });

      await prisma.$transaction(async (tx) => {
        // Mutate the Plaid row in place: it becomes the MS-linked Transaction
        // and grows InventoryAsset children.
        await tx.transaction.update({
          where: { id: plaid.id },
          data: {
            status: "RECONCILED_MS",
            reconciledAt: new Date(),
            // merchant gets normalized in case Plaid returned "KS #123"
            merchant: plaid.merchant ?? "King Soopers",
          },
        });

        const seeds = [
          split.giftCard,
          split.fuelPoints,
          split.cashback,
          split.mrPoints,
        ].filter((s): s is NonNullable<typeof s> => Boolean(s));

        for (const seed of seeds) {
          await tx.inventoryAsset.create({
            data: {
              ...seed,
              sourceTransactionId: plaid.id,
              acquiredDate: plaid.date,
            },
          });
        }
      });
      // currentSpend was already correct from sync; no recompute needed
      // (status change doesn't affect the filter).
      return NextResponse.json({ ok: true });
    }
  }
}
