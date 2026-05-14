import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  BBY_LIQUIDATION_RATE_MID,
  CARD_SPECS,
  CARD_TYPE,
  FUEL_POINT_VALUE_MID,
  KINGSOOPERS_DEFAULT_FUEL_MULTIPLIER,
  cardContributesToMSR,
  splitKingSoopersRun,
  type CardType,
} from "@/lib/constants";

/**
 * Manual King Soopers run logger.
 *
 * This endpoint is the authoritative source for INVENTORY acquired at King
 * Soopers — the BBY gift card, the fuel points, and (for cards that earn them)
 * the MR points / cashback on the gift card portion.
 *
 * It is NOT authoritative for card spend / MSR. That job belongs to Plaid
 * (which sees the real card-charge amount including incidentals like a drink
 * at the register). Manual entries therefore do not touch Card.currentSpend;
 * the eventual Plaid-ingested Transaction row will via reconciliation.
 */

const BodySchema = z.object({
  /** Gift card face value acquired (not the total card charge). */
  faceValue: z.number().positive().max(100_000),
  /** If omitted we fall back to a Venmo card (auto-created on first run). */
  cardId: z.string().optional(),
  /** $ per fuel point. Accepts either per-point (0.0195) or per-1000 (19.50). */
  fuelRate: z.number().positive().max(100).optional(),
  /** Kroger promo multiplier (2, 3, 4, 5...). Defaults to 4. */
  fuelMultiplier: z.number().positive().max(10).optional(),
  /**
   * BBY liquidation rate for this run. Accepts either decimal (0.92) or
   * percent (92). Drives InventoryAsset.expectedLiquidationValue.
   */
  liquidationRate: z.number().positive().max(100).optional(),
  notes: z.string().max(500).optional().nullable(),
  date: z.string().datetime().optional(),
});

function normalizeFuelRate(input?: number): number {
  if (input === undefined) return FUEL_POINT_VALUE_MID;
  return input >= 1 ? input / 1000 : input;
}

function normalizeLiquidationRate(input?: number): number {
  if (input === undefined) return BBY_LIQUIDATION_RATE_MID;
  // Accept either decimal (0.92) or percent (92).
  return input > 1 ? input / 100 : input;
}

const KNOWN_CARD_TYPES = new Set<string>([
  CARD_TYPE.ABP,
  CARD_TYPE.ABG,
  CARD_TYPE.VENMO,
  CARD_TYPE.OTHER,
]);

/**
 * GET /api/king-soopers-run?limit=N
 *
 * Recent runs for the dashboard "Recent runs" panel. Returns each run's
 * Transaction row plus its child InventoryAssets (so the UI can show
 * face/fuel/MR breakdown without a second round-trip), and a flag for
 * whether any of the children have been liquidated (which gates edit/delete).
 */
export async function GET(req: NextRequest) {
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(Math.max(Number(limitParam) || 30, 1), 200);

  const rows = await prisma.transaction.findMany({
    where: {
      merchant: "King Soopers",
      // Only surface rows that produced inventory; ignore plain Plaid-categorized
      // grocery runs at King Soopers that aren't MS.
      assets: { some: {} },
    },
    orderBy: { date: "desc" },
    take: limit,
    include: {
      card: { select: { id: true, type: true, nickname: true } },
      assets: {
        include: { liquidation: { select: { id: true } } },
      },
    },
  });

  return NextResponse.json({
    runs: rows.map((r) => {
      const gc = r.assets.find((a) => a.type === "GIFT_CARD");
      const fuel = r.assets.find((a) => a.type === "FUEL_POINTS");
      const mr = r.assets.find((a) => a.type === "MR_POINTS");
      const cashback = r.assets.find((a) => a.type === "CASHBACK");
      // Fuel multiplier is fuel.quantity / GC face. We use the GC asset
      // quantity (the actual face value) rather than Transaction.amount —
      // for Plaid-reconciled runs the latter is the full card charge
      // (face + drink + tax) which would skew the multiplier (e.g. 3.99x).
      const faceValue = gc?.quantity ?? r.amount;
      const fuelMultiplier =
        fuel && faceValue > 0 ? fuel.quantity / faceValue : null;
      const fuelRate =
        fuel && fuel.quantity > 0 ? fuel.expectedLiquidationValue / fuel.quantity : null;
      const liquidationRate =
        gc && gc.quantity > 0 ? gc.expectedLiquidationValue / gc.quantity : null;
      const anyLiquidated = r.assets.some((a) => a.liquidation);
      return {
        id: r.id,
        date: r.date,
        amount: r.amount,
        notes: r.notes,
        plaidTransactionId: r.plaidTransactionId,
        status: r.status,
        cardId: r.card.id,
        cardLabel: r.card.nickname ?? r.card.type,
        cardType: r.card.type,
        fuelMultiplier,
        fuelRatePerPoint: fuelRate,
        liquidationRate,
        anyLiquidated,
        breakdown: {
          giftCardFace: gc?.quantity ?? null,
          fuelPoints: fuel?.quantity ?? null,
          mrPoints: mr?.quantity ?? null,
          cashbackDollars: cashback?.quantity ?? null,
        },
      };
    }),
  });
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

  const { faceValue, cardId, notes } = parsed.data;
  const fuelRate = normalizeFuelRate(parsed.data.fuelRate);
  const fuelMultiplier =
    parsed.data.fuelMultiplier ?? KINGSOOPERS_DEFAULT_FUEL_MULTIPLIER;
  const liquidationRate = normalizeLiquidationRate(parsed.data.liquidationRate);
  const date = parsed.data.date ? new Date(parsed.data.date) : new Date();

  let card = cardId
    ? await prisma.card.findUnique({ where: { id: cardId } })
    : await prisma.card.findFirst({
        where: { type: CARD_TYPE.VENMO, closed: false },
        orderBy: { openDate: "desc" },
      });

  if (cardId && !card) {
    return NextResponse.json({ error: "Card not found" }, { status: 404 });
  }
  if (!card) {
    card = await prisma.card.create({
      data: {
        type: CARD_TYPE.VENMO,
        nickname: "Venmo Credit Card",
        openDate: new Date(),
        spendTarget: CARD_SPECS.VENMO.spendTarget,
        cooldownDays: CARD_SPECS.VENMO.cooldownDays,
      },
    });
  }

  const cardType: CardType = KNOWN_CARD_TYPES.has(card.type)
    ? (card.type as CardType)
    : CARD_TYPE.OTHER;

  const split = splitKingSoopersRun({
    dollars: faceValue,
    cardType,
    fuelRate,
    fuelMultiplier,
    liquidationRate,
  });

  const result = await prisma.$transaction(async (tx) => {
    // Create a Transaction row. `amount` here equals the face value — it's
    // all we know from manual entry. When Plaid later matches its real
    // card-charge txn to this row via /api/transactions/reconcile, the row's
    // amount + plaidTransactionId get updated to reflect the true charge.
    const txn = await tx.transaction.create({
      data: {
        cardId: card!.id,
        date,
        merchant: "King Soopers",
        amount: faceValue,
        notes: notes ?? null,
      },
    });

    const seeds = [split.giftCard, split.fuelPoints, split.cashback, split.mrPoints].filter(
      (s): s is NonNullable<typeof s> => Boolean(s),
    );

    const assets = await Promise.all(
      seeds.map((seed) =>
        tx.inventoryAsset.create({
          data: { ...seed, sourceTransactionId: txn.id, acquiredDate: date },
        }),
      ),
    );

    return { txn, assets };
  });

  return NextResponse.json(
    {
      ok: true,
      transactionId: result.txn.id,
      cardId: card.id,
      cardType,
      fuelRatePerPoint: fuelRate,
      fuelMultiplier,
      liquidationRate,
      // Manual entries never bump currentSpend. Plaid is authoritative for MSR.
      contributesToMSR: false,
      wouldHaveContributedIfPlaidDisconnected: cardContributesToMSR(cardType),
      assets: result.assets.map((a) => ({
        id: a.id,
        type: a.type,
        subType: a.subType,
        quantity: a.quantity,
        acquisitionCost: a.acquisitionCost,
        expectedLiquidationValue: a.expectedLiquidationValue,
      })),
    },
    { status: 201 },
  );
}
