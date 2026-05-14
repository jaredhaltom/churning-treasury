import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  ASSET_TYPE,
  MR_POINT_VALUE,
  PROCEEDS_TYPE,
  type AssetType,
} from "@/lib/constants";
import { liquidateBulk, liquidateOne } from "@/lib/inventory-ops";

/**
 * POST /api/liquidations
 *
 * Two flavors via discriminated union:
 *
 *   { mode: "single", assetId, quantity?, realizedRevenue, buyer, ... }
 *     - Liquidate a single inventory row, optionally partial.
 *     - Use for BBY gift cards (each row = a distinct card).
 *
 *   { mode: "bulk", type, quantity, realizedRevenue, buyer, subTypeStartsWith?, ... }
 *     - FIFO drain across all HELD rows of a given asset type.
 *     - Use for fuel points / MR / cashback where individual rows are
 *       fungible.
 *
 * Revenue is allocated pro-rata in bulk mode. Profit per line = revenue
 * minus that line's pro-rated acquisitionCost.
 *
 * Tip for the "expired fuel points" case: bulk mode with realizedRevenue=0
 * and buyer="Expired" produces a clean ledger entry showing the loss.
 */

const SingleSchema = z.object({
  mode: z.literal("single"),
  assetId: z.string().min(1),
  quantity: z.number().positive().optional(),
  realizedRevenue: z.number().nonnegative(),
  buyer: z.string().min(1).max(100),
  proceedsType: z
    .enum([PROCEEDS_TYPE.CASH, PROCEEDS_TYPE.NON_CASH])
    .optional()
    .default(PROCEEDS_TYPE.CASH),
  rebateRate: z.number().min(0).max(0.9).optional(),
  date: z.string().datetime().optional(),
  notes: z.string().max(500).optional().nullable(),
});

const BulkSchema = z.object({
  mode: z.literal("bulk"),
  type: z.enum([
    ASSET_TYPE.GIFT_CARD,
    ASSET_TYPE.FUEL_POINTS,
    ASSET_TYPE.MR_POINTS,
    ASSET_TYPE.CASHBACK,
  ]),
  subTypeStartsWith: z.string().max(40).optional(),
  quantity: z.number().positive(),
  realizedRevenue: z.number().nonnegative(),
  buyer: z.string().min(1).max(100),
  proceedsType: z
    .enum([PROCEEDS_TYPE.CASH, PROCEEDS_TYPE.NON_CASH])
    .optional()
    .default(PROCEEDS_TYPE.CASH),
  rebateRate: z.number().min(0).max(0.9).optional(),
  date: z.string().datetime().optional(),
  notes: z.string().max(500).optional().nullable(),
});

const BodySchema = z.discriminatedUnion("mode", [SingleSchema, BulkSchema]);

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

  try {
    const date = parsed.data.date ? new Date(parsed.data.date) : undefined;
    if (parsed.data.mode === "single") {
      const lines = await liquidateOne({
        assetId: parsed.data.assetId,
        quantity: parsed.data.quantity,
        realizedRevenue: parsed.data.realizedRevenue,
        buyer: parsed.data.buyer,
        proceedsType: parsed.data.proceedsType,
        date,
        notes: parsed.data.notes ?? null,
      });
      return NextResponse.json({ ok: true, lines }, { status: 201 });
    }
    const lines = await liquidateBulk({
      type: parsed.data.type as AssetType,
      subTypeStartsWith: parsed.data.subTypeStartsWith,
      quantity: parsed.data.quantity,
      realizedRevenue: parsed.data.realizedRevenue,
      buyer: parsed.data.buyer,
      proceedsType: parsed.data.proceedsType,
      date,
      notes: parsed.data.notes ?? null,
    });
    let rebateMinted = 0;
    if (
      parsed.data.type === ASSET_TYPE.MR_POINTS &&
      (parsed.data.rebateRate ?? 0) > 0
    ) {
      const rebateRate = parsed.data.rebateRate ?? 0;
      rebateMinted = parsed.data.quantity * rebateRate;
      await prisma.inventoryAsset.create({
        data: {
          type: ASSET_TYPE.MR_POINTS,
          subType:
            parsed.data.proceedsType === PROCEEDS_TYPE.CASH
              ? `REBATE-${(rebateRate * 100).toFixed(0)}%-BROKERED`
              : `REBATE-${(rebateRate * 100).toFixed(0)}%`,
          quantity: rebateMinted,
          acquisitionCost: 0,
          expectedLiquidationValue: rebateMinted * MR_POINT_VALUE,
          acquiredDate: date ?? new Date(),
        },
      });
    }
    return NextResponse.json({ ok: true, lines, rebateMinted }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Liquidation failed" },
      { status: 400 },
    );
  }
}

/**
 * GET /api/liquidations
 *
 * Recent liquidation events for the dashboard ledger.
 */
export async function GET() {
  const events = await prisma.liquidationEvent.findMany({
    orderBy: { date: "desc" },
    take: 50,
    include: { inventoryAsset: true },
  });
  return NextResponse.json({
    events: events.map((e) => ({
      id: e.id,
      date: e.date,
      buyer: e.buyer,
      proceedsType: e.proceedsType,
      realizedRevenue: e.realizedRevenue,
      profit: e.profit,
      daysToLiquidation: e.daysToLiquidation,
      notes: e.notes,
      asset: {
        id: e.inventoryAsset.id,
        type: e.inventoryAsset.type,
        subType: e.inventoryAsset.subType,
        quantity: e.inventoryAsset.quantity,
        acquisitionCost: e.inventoryAsset.acquisitionCost,
      },
    })),
  });
}

export const dynamic = "force-dynamic";
