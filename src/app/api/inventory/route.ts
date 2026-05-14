import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ASSET_STATUS } from "@/lib/constants";

/**
 * GET /api/inventory
 *
 * Snapshot of currently HELD inventory for the liquidation drawer.
 * Returns:
 *   - per-row detail (used for per-asset liquidation, e.g. individual BBY GCs)
 *   - per-type aggregate (used for bulk-FIFO liquidation, e.g. fuel points)
 */
export async function GET() {
  const rows = await prisma.inventoryAsset.findMany({
    where: { status: { not: ASSET_STATUS.LIQUIDATED } },
    orderBy: { acquiredDate: "asc" },
    include: {
      sourceTransaction: {
        select: { merchant: true, date: true, card: { select: { type: true, nickname: true } } },
      },
    },
  });

  const byType = new Map<
    string,
    { type: string; quantity: number; acquisitionCost: number; expectedLiquidationValue: number; count: number }
  >();
  for (const r of rows) {
    const cur = byType.get(r.type) ?? {
      type: r.type,
      quantity: 0,
      acquisitionCost: 0,
      expectedLiquidationValue: 0,
      count: 0,
    };
    cur.quantity += r.quantity;
    cur.acquisitionCost += r.acquisitionCost;
    cur.expectedLiquidationValue += r.expectedLiquidationValue;
    cur.count += 1;
    byType.set(r.type, cur);
  }

  return NextResponse.json({
    aggregates: [...byType.values()],
    rows: rows.map((r) => ({
      id: r.id,
      type: r.type,
      subType: r.subType,
      status: r.status,
      quantity: r.quantity,
      acquisitionCost: r.acquisitionCost,
      expectedLiquidationValue: r.expectedLiquidationValue,
      acquiredDate: r.acquiredDate,
      sourceMerchant: r.sourceTransaction?.merchant ?? null,
      cardLabel:
        r.sourceTransaction?.card?.nickname ??
        r.sourceTransaction?.card?.type ??
        null,
    })),
  });
}

export const dynamic = "force-dynamic";
