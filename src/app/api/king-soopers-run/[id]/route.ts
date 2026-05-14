import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  ASSET_STATUS,
  BBY_LIQUIDATION_RATE_MID,
  CARD_TYPE,
  FUEL_POINT_VALUE_MID,
  KINGSOOPERS_DEFAULT_FUEL_MULTIPLIER,
  splitKingSoopersRun,
  type CardType,
} from "@/lib/constants";

/**
 * PATCH/DELETE /api/king-soopers-run/:id
 *
 * Lets the user fix a manual run after the fact (e.g. recorded 4x fuel when
 * Kroger only ran a 2x promo). Editing rebuilds the InventoryAsset children
 * from scratch using the same split logic as creation. Any asset row that
 * has already been liquidated is treated as a hard wall — we don't silently
 * delete liquidation history. Caller must reverse the liquidation first.
 */

const PatchSchema = z
  .object({
    faceValue: z.number().positive().max(100_000).optional(),
    fuelRate: z.number().positive().max(100).optional(),
    fuelMultiplier: z.number().positive().max(10).optional(),
    liquidationRate: z.number().positive().max(100).optional(),
    notes: z.string().max(500).nullable().optional(),
    date: z.string().datetime().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

const KNOWN_CARD_TYPES = new Set<string>([
  CARD_TYPE.ABP,
  CARD_TYPE.ABG,
  CARD_TYPE.VENMO,
  CARD_TYPE.OTHER,
]);

function normalizeFuelRate(input?: number): number | undefined {
  if (input === undefined) return undefined;
  return input >= 1 ? input / 1000 : input;
}
function normalizeLiquidationRate(input?: number): number | undefined {
  if (input === undefined) return undefined;
  return input > 1 ? input / 100 : input;
}

interface RunMeta {
  fuelRate: number;
  fuelMultiplier: number;
  liquidationRate: number;
}

/**
 * Recover the original run parameters from the existing asset rows so we
 * only have to update the fields the user actually changed. The KS run
 * splitter encodes the multiplier in fuel-asset subType ("KS-4x") and the
 * BBY liquidation rate in the GC subType ("BBY-92.5%"), so the round-trip
 * is lossless.
 */
function inferMeta(
  assets: Array<{ type: string; subType: string | null; quantity: number; expectedLiquidationValue: number; acquisitionCost: number }>,
  faceValue: number,
): RunMeta {
  const gc = assets.find((a) => a.type === "GIFT_CARD");
  const fuel = assets.find((a) => a.type === "FUEL_POINTS");

  const fuelMultiplier = fuel && faceValue > 0 ? fuel.quantity / faceValue : KINGSOOPERS_DEFAULT_FUEL_MULTIPLIER;
  const fuelRate = fuel && fuel.quantity > 0
    ? fuel.expectedLiquidationValue / fuel.quantity
    : FUEL_POINT_VALUE_MID;
  const liquidationRate = gc && gc.quantity > 0
    ? gc.expectedLiquidationValue / gc.quantity
    : BBY_LIQUIDATION_RATE_MID;
  return { fuelRate, fuelMultiplier, liquidationRate };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const txn = await prisma.transaction.findUnique({
    where: { id },
    include: { assets: { include: { liquidation: true } }, card: true },
  });
  if (!txn) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  if (txn.assets.some((a) => a.liquidation)) {
    return NextResponse.json(
      {
        error:
          "One or more assets from this run have been liquidated. Reverse the liquidation before editing the run.",
      },
      { status: 409 },
    );
  }

  const cardType: CardType = KNOWN_CARD_TYPES.has(txn.card.type)
    ? (txn.card.type as CardType)
    : CARD_TYPE.OTHER;

  // Use the GC asset's quantity as the source of truth for face value, not
  // Transaction.amount. For Plaid-reconciled rows the latter is the real
  // card charge (face + drink + tax) and would corrupt the inferred
  // multiplier (e.g. a 4x run would round-trip as 3.989x).
  const existingGcQty =
    txn.assets.find((a) => a.type === "GIFT_CARD")?.quantity ?? txn.amount;
  const existingMeta = inferMeta(txn.assets, existingGcQty);

  const faceValue = parsed.data.faceValue ?? existingGcQty;
  const fuelRate = normalizeFuelRate(parsed.data.fuelRate) ?? existingMeta.fuelRate;
  const fuelMultiplier = parsed.data.fuelMultiplier ?? existingMeta.fuelMultiplier;
  const liquidationRate =
    normalizeLiquidationRate(parsed.data.liquidationRate) ?? existingMeta.liquidationRate;
  const date = parsed.data.date ? new Date(parsed.data.date) : txn.date;

  const split = splitKingSoopersRun({
    dollars: faceValue,
    cardType,
    fuelRate,
    fuelMultiplier,
    liquidationRate,
  });

  const result = await prisma.$transaction(async (tx) => {
    // Only sync Transaction.amount to face value for unreconciled (manual)
    // rows. Plaid-linked rows must keep the real card charge as their
    // amount — that number is what counts toward MSR, not the GC face.
    const amountUpdate = txn.plaidTransactionId ? {} : { amount: faceValue };
    await tx.transaction.update({
      where: { id },
      data: {
        ...amountUpdate,
        date,
        notes: parsed.data.notes ?? txn.notes,
      },
    });
    // Wipe and re-seed children. Safe because we already verified none are
    // liquidated (LiquidationEvent has onDelete: Cascade from the asset).
    await tx.inventoryAsset.deleteMany({ where: { sourceTransactionId: id } });

    const seeds = [split.giftCard, split.fuelPoints, split.cashback, split.mrPoints]
      .filter((s): s is NonNullable<typeof s> => Boolean(s));
    const assets = await Promise.all(
      seeds.map((seed) =>
        tx.inventoryAsset.create({
          data: {
            ...seed,
            sourceTransactionId: id,
            acquiredDate: date,
            status: ASSET_STATUS.HELD,
          },
        }),
      ),
    );
    return { assets };
  });

  return NextResponse.json({
    ok: true,
    transactionId: id,
    fuelRate,
    fuelMultiplier,
    liquidationRate,
    assets: result.assets.map((a) => ({
      id: a.id,
      type: a.type,
      subType: a.subType,
      quantity: a.quantity,
    })),
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const txn = await prisma.transaction.findUnique({
    where: { id },
    include: { assets: { include: { liquidation: true } } },
  });
  if (!txn) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  if (txn.assets.some((a) => a.liquidation)) {
    return NextResponse.json(
      {
        error:
          "Cannot delete a run whose assets have been liquidated. Reverse the liquidation first.",
      },
      { status: 409 },
    );
  }
  // Refuse to delete Plaid-linked rows here; that's the Inbox's job.
  if (txn.plaidTransactionId) {
    return NextResponse.json(
      {
        error:
          "This run is linked to a Plaid transaction. Use the Inbox to unreconcile, or delete the manual portion via /api/transactions.",
      },
      { status: 409 },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.inventoryAsset.deleteMany({ where: { sourceTransactionId: id } });
    await tx.transaction.delete({ where: { id } });
  });
  return NextResponse.json({ ok: true });
}
