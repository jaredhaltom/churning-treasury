/**
 * One-shot reconciliation from the AI payout CSVs and a manual entry for
 * Alec's fuel purchases via the Churning Life Slack.
 *
 * The user originally entered gift-card and fuel-point liquidations by hand
 * with a few mistakes (wrong rate on a few KS runs, a $1003 face-value typo
 * caused by the now-fixed Plaid charge / face confusion, fuel sales lumped
 * into one event rather than the actual five). This script wipes those
 * GIFT_CARD + FUEL_POINTS LiquidationEvent rows, resets the inventory back
 * to HELD, then replays the truth from the CSVs:
 *
 *   - GC sales: 22 reservations, $19,995 total to "Aligned Incentives"
 *   - Fuel: 3 events (46k pts → $863.50) to "Aligned Incentives"
 *   - Fuel: 2 events (10k → $180 on 3/11, 15k → $292.50 on 4/15) to
 *     "Alec (Churning Life Slack)"
 *   - Fuel expiry: 1,005 pts → $0 to "Expired"
 *
 * MR_POINTS and CASHBACK assets are untouched.
 *
 * Usage:
 *   node --import tsx scripts/reconcile-from-ai-csv.ts            # dry run
 *   node --import tsx scripts/reconcile-from-ai-csv.ts --commit   # apply
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const COMMIT = process.argv.includes("--commit");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const AI_DIR = path.join(PROJECT_ROOT, "AI payout data");
const GC_CSV = path.join(
  AI_DIR,
  "alignedincentives_data_export_for_2026_2026-04-25-141021.csv",
);
const FUEL_CSV = path.join(
  AI_DIR,
  "alignedincentives_fuel_export_for_2026_2026-04-25-141027.csv",
);

const AI_BUYER = "Aligned Incentives";
const ALEC_BUYER = "Alec (Churning Life Slack)";
const EXPIRED_BUYER = "Expired";

interface GcCsvRow {
  brand: string;
  denom: number;
  resellAt: Date;
  buyPrice: number;
}

interface FuelCsvRow {
  buyer: string;
  points: number;
  netAmount: number;
  payoutDate: Date;
  submittedDate: Date;
}

function parseCsv(p: string): string[][] {
  const text = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n").trim();
  return text.split("\n").map((line) => line.split(","));
}

function parseDateMDY(s: string): Date {
  // Accepts "M/D/YYYY" or "MM/DD/YYYY HH:MM:SS"
  const [datePart, timePart] = s.split(" ");
  const [mm, dd, yyyy] = datePart.split("/").map(Number);
  if (timePart) {
    const [h, m, sec] = timePart.split(":").map(Number);
    return new Date(yyyy, mm - 1, dd, h, m, sec ?? 0);
  }
  return new Date(yyyy, mm - 1, dd, 12, 0, 0); // noon, avoid TZ edge
}

function loadGcRows(): GcCsvRow[] {
  const [, ...rows] = parseCsv(GC_CSV);
  return rows.map((r) => ({
    brand: r[0],
    denom: Number(r[1]),
    buyPrice: Number(r[4]),
    resellAt: parseDateMDY(r[6]),
  }));
}

function loadFuelRows(): FuelCsvRow[] {
  const [, ...rows] = parseCsv(FUEL_CSV);
  return rows.map((r) => ({
    buyer: r[0],
    points: Number(r[4]),
    netAmount: Number(r[8]),
    submittedDate: parseDateMDY(r[11]),
    payoutDate: parseDateMDY(r[12]),
  }));
}

interface Reservation {
  resellAt: Date;
  totalFace: number;
  totalRevenue: number;
  rows: GcCsvRow[];
}

/** AI groups gift cards into reservations (~one redemption batch). The CSV
 * encodes that via identical ResellDateTime values across paired rows. */
function groupReservations(rows: GcCsvRow[]): Reservation[] {
  const map = new Map<string, Reservation>();
  for (const r of rows) {
    const key = r.resellAt.toISOString();
    let res = map.get(key);
    if (!res) {
      res = { resellAt: r.resellAt, totalFace: 0, totalRevenue: 0, rows: [] };
      map.set(key, res);
    }
    res.rows.push(r);
    res.totalFace += r.denom;
    res.totalRevenue += r.buyPrice;
  }
  return [...map.values()].sort(
    (a, b) => a.resellAt.getTime() - b.resellAt.getTime(),
  );
}

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

interface PlannedGcLiquidation {
  assetId: string;
  acquiredDate: Date;
  acquisitionCost: number;
  faceQty: number;
  saleDate: Date;
  revenue: number;
  buyer: string;
}

interface PlannedFuelLiquidation {
  assetId: string;
  acquiredDate: Date;
  acquisitionCost: number;
  qty: number;
  saleDate: Date;
  revenue: number;
  buyer: string;
}

async function main() {
  console.log(
    `\n=== AI reconciliation (${COMMIT ? "COMMIT" : "DRY RUN"}) ===\n`,
  );

  const gcRows = loadGcRows();
  const reservations = groupReservations(gcRows);
  const fuelRows = loadFuelRows();

  const csvGcTotal = reservations.reduce((s, r) => s + r.totalRevenue, 0);
  const csvAiFuelTotal = fuelRows.reduce((s, r) => s + r.netAmount, 0);
  const csvAlecTotal = 180 + 292.5;

  console.log(`CSV gift card total:  ${fmtUsd(csvGcTotal)} across ${reservations.length} reservations`);
  console.log(`CSV AI fuel total:    ${fmtUsd(csvAiFuelTotal)} across ${fuelRows.length} events`);
  console.log(`Alec fuel:            ${fmtUsd(csvAlecTotal)} (10k @ $18/k on 3/11 + 15k @ $19.50/k on 4/15)`);
  console.log(`Expected revenue:     ${fmtUsd(csvGcTotal + csvAiFuelTotal + csvAlecTotal)}\n`);

  // Snapshot prior state for the diff at the end.
  const priorGcRevenue = await prisma.liquidationEvent.aggregate({
    _sum: { realizedRevenue: true },
    where: { inventoryAsset: { type: "GIFT_CARD" } },
  });
  const priorFuelRevenue = await prisma.liquidationEvent.aggregate({
    _sum: { realizedRevenue: true },
    where: { inventoryAsset: { type: "FUEL_POINTS" } },
  });

  console.log(`Prior recorded GC revenue:   ${fmtUsd(priorGcRevenue._sum.realizedRevenue ?? 0)}`);
  console.log(`Prior recorded fuel revenue: ${fmtUsd(priorFuelRevenue._sum.realizedRevenue ?? 0)}\n`);

  // Pull the inventory rows we'll be replaying. We treat all GC/FUEL rows
  // (regardless of current status) as a single pool, FIFO by acquiredDate.
  const gcAssetsRaw = await prisma.inventoryAsset.findMany({
    where: { type: "GIFT_CARD" },
    orderBy: { acquiredDate: "asc" },
  });
  const fuelAssetsRaw = await prisma.inventoryAsset.findMany({
    where: { type: "FUEL_POINTS" },
    orderBy: { acquiredDate: "asc" },
  });

  console.log(`GC assets in DB:   ${gcAssetsRaw.length}, total face ${gcAssetsRaw.reduce((s, a) => s + a.quantity, 0)}`);
  console.log(`Fuel assets in DB: ${fuelAssetsRaw.length}, total qty  ${fuelAssetsRaw.reduce((s, a) => s + a.quantity, 0)}\n`);

  // -------------------------------------------------------------------------
  // Normalize asset quantities. Plaid-reconciled runs created a few rows
  // where the GC face / fuel-pt qty inherited the actual card charge
  // (e.g. $1002.69) rather than the clean face value. Snap each row to the
  // nearest valid denomination so the reservation matcher has a clean pool.
  //
  //   GC: snap to nearest of {500, 1000}
  //   Fuel: snap to nearest 1000 (KS earnings always come in 1k multiples
  //         from face values of 500/1000 × multipliers of 2x/4x)
  //
  // We track a normalization list to apply inside the transaction.
  // -------------------------------------------------------------------------
  interface QtyFix {
    id: string;
    oldQty: number;
    newQty: number;
    reason: string;
  }
  const qtyFixes: QtyFix[] = [];
  const dropIds: string[] = [];

  function snapTo(values: number[], q: number, tolerance: number): number | null {
    let best: { v: number; d: number } | null = null;
    for (const v of values) {
      const d = Math.abs(q - v);
      if (d <= tolerance && (best === null || d < best.d)) {
        best = { v, d };
      }
    }
    return best?.v ?? null;
  }

  function scaleInPlace(a: { quantity: number; acquisitionCost: number; expectedLiquidationValue: number }, newQty: number) {
    const ratio = a.quantity > 0 ? newQty / a.quantity : 1;
    a.acquisitionCost *= ratio;
    a.expectedLiquidationValue *= ratio;
    a.quantity = newQty;
  }

  const gcAssets = gcAssetsRaw.map((a) => ({ ...a }));
  for (const a of gcAssets) {
    const target = snapTo([500, 1000], a.quantity, 50);
    if (target !== null && Math.abs(target - a.quantity) > 1e-6) {
      qtyFixes.push({
        id: a.id,
        oldQty: a.quantity,
        newQty: target,
        reason: `GC face ${a.quantity.toFixed(2)} -> ${target}`,
      });
      scaleInPlace(a, target);
    }
  }

  const fuelAssets = fuelAssetsRaw.map((a) => ({ ...a }));
  for (const a of fuelAssets) {
    if (a.quantity < 1) {
      dropIds.push(a.id);
      continue;
    }
    const target = Math.round(a.quantity / 1000) * 1000;
    if (Math.abs(target - a.quantity) > 1e-6) {
      qtyFixes.push({
        id: a.id,
        oldQty: a.quantity,
        newQty: target,
        reason: `Fuel qty ${a.quantity.toFixed(2)} -> ${target}`,
      });
      scaleInPlace(a, target);
    }
  }
  // Filter out dropped fuel rows from the in-memory pool too.
  const dropSet = new Set(dropIds);
  const fuelAssetsPool = fuelAssets.filter((a) => !dropSet.has(a.id));

  if (qtyFixes.length > 0 || dropIds.length > 0) {
    console.log("Asset normalizations:");
    for (const f of qtyFixes) console.log(`  ${f.reason} (id ${f.id.slice(-6)})`);
    for (const id of dropIds) console.log(`  Drop residual fuel asset (id ${id.slice(-6)})`);
    console.log();
  }

  console.log(`GC pool after normalize:   ${gcAssets.length}, face total ${gcAssets.reduce((s, a) => s + a.quantity, 0)}`);
  console.log(`Fuel pool after normalize: ${fuelAssetsPool.length}, qty total ${fuelAssetsPool.reduce((s, a) => s + a.quantity, 0)}\n`);

  // -------------------------------------------------------------------------
  // Plan GC liquidations: FIFO match by face value
  // -------------------------------------------------------------------------
  const gcPool = gcAssets;

  const gcPlan: PlannedGcLiquidation[] = [];
  for (const res of reservations) {
    const idx = gcPool.findIndex(
      (a) => a.quantity === res.totalFace && !gcPlan.some((p) => p.assetId === a.id),
    );
    if (idx === -1) {
      throw new Error(
        `No HELD GC asset of face ${res.totalFace} for reservation at ${res.resellAt.toISOString()}`,
      );
    }
    const a = gcPool[idx];
    gcPlan.push({
      assetId: a.id,
      acquiredDate: a.acquiredDate,
      acquisitionCost: a.acquisitionCost,
      faceQty: res.totalFace,
      saleDate: res.resellAt,
      revenue: res.totalRevenue,
      buyer: AI_BUYER,
    });
  }

  console.log(`Planned GC liquidations: ${gcPlan.length}`);
  console.log(`  -> total revenue: ${fmtUsd(gcPlan.reduce((s, p) => s + p.revenue, 0))}\n`);

  // -------------------------------------------------------------------------
  // Plan fuel liquidations: split FIFO across the AI events + Alec + expiry
  // -------------------------------------------------------------------------
  type FuelEvent = { qty: number; revenue: number; date: Date; buyer: string };
  const fuelEvents: FuelEvent[] = [
    ...fuelRows.map((r) => ({
      qty: r.points,
      revenue: r.netAmount,
      date: r.payoutDate,
      buyer: AI_BUYER,
    })),
    { qty: 10000, revenue: 180, date: new Date(2026, 2, 11, 12), buyer: ALEC_BUYER },
    { qty: 15000, revenue: 292.5, date: new Date(2026, 3, 15, 12), buyer: ALEC_BUYER },
    { qty: 1000, revenue: 0, date: new Date(2026, 3, 25, 12), buyer: EXPIRED_BUYER },
  ];

  // FIFO consume the fuel pool; we need to track per-asset remaining qty so
  // a single asset can fund multiple liquidations.
  const fuelRemaining = new Map<string, number>(
    fuelAssetsPool.map((a) => [a.id, a.quantity]),
  );

  const fuelPlan: PlannedFuelLiquidation[] = [];
  for (const ev of fuelEvents) {
    let need = ev.qty;
    let revenueRemaining = ev.revenue;
    for (const a of fuelAssetsPool) {
      if (need <= 0) break;
      const left = fuelRemaining.get(a.id) ?? 0;
      if (left <= 0) continue;
      const take = Math.min(left, need);
      const ratio = take / ev.qty;
      const lineRevenue =
        take === need
          ? revenueRemaining
          : Number((ev.revenue * ratio).toFixed(2));
      fuelPlan.push({
        assetId: a.id,
        acquiredDate: a.acquiredDate,
        acquisitionCost: a.acquisitionCost * (take / a.quantity),
        qty: take,
        saleDate: ev.date,
        revenue: lineRevenue,
        buyer: ev.buyer,
      });
      fuelRemaining.set(a.id, left - take);
      need -= take;
      revenueRemaining -= lineRevenue;
    }
    if (need > 1e-6) {
      throw new Error(
        `Fuel pool exhausted for event ${ev.buyer} ${ev.qty}; short by ${need}`,
      );
    }
  }

  const fuelTotalRevenue = fuelPlan.reduce((s, p) => s + p.revenue, 0);
  console.log(`Planned fuel liquidations: ${fuelPlan.length}`);
  console.log(`  -> total revenue: ${fmtUsd(fuelTotalRevenue)}`);
  console.log(`  -> by buyer:`);
  const byBuyer = new Map<string, { qty: number; rev: number }>();
  for (const p of fuelPlan) {
    const cur = byBuyer.get(p.buyer) ?? { qty: 0, rev: 0 };
    cur.qty += p.qty;
    cur.rev += p.revenue;
    byBuyer.set(p.buyer, cur);
  }
  for (const [buyer, t] of byBuyer) {
    console.log(`     ${buyer.padEnd(30)} ${t.qty.toLocaleString().padStart(7)} pts  ${fmtUsd(t.rev)}`);
  }
  console.log();

  if (!COMMIT) {
    console.log("DRY RUN — no changes written. Re-run with --commit to apply.\n");
    await prisma.$disconnect();
    return;
  }

  // -------------------------------------------------------------------------
  // Apply
  // -------------------------------------------------------------------------
  await prisma.$transaction(async (tx) => {
    // 1. Delete existing GC + fuel LiquidationEvent rows.
    const deleted = await tx.liquidationEvent.deleteMany({
      where: { inventoryAsset: { type: { in: ["GIFT_CARD", "FUEL_POINTS"] } } },
    });
    console.log(`Deleted ${deleted.count} existing LiquidationEvent rows`);

    // 2. Reset assets to HELD.
    await tx.inventoryAsset.updateMany({
      where: { type: { in: ["GIFT_CARD", "FUEL_POINTS"] } },
      data: { status: "HELD" },
    });

    // 3. Apply qty normalizations (snap GC face to 500/1000, fuel to nearest 1k).
    for (const f of qtyFixes) {
      const a = await tx.inventoryAsset.findUniqueOrThrow({ where: { id: f.id } });
      const ratio = a.quantity > 0 ? f.newQty / a.quantity : 1;
      await tx.inventoryAsset.update({
        where: { id: f.id },
        data: {
          quantity: f.newQty,
          expectedLiquidationValue: a.expectedLiquidationValue * ratio,
          acquisitionCost: a.acquisitionCost * ratio,
        },
      });
    }
    if (qtyFixes.length > 0) console.log(`Normalized ${qtyFixes.length} asset qty rows`);

    // 4. Drop residual fuel rows whose qty rounds to zero.
    if (dropIds.length > 0) {
      await tx.inventoryAsset.deleteMany({ where: { id: { in: dropIds } } });
      console.log(`Removed ${dropIds.length} residual fuel asset(s)`);
    }

    // 5. Replay GC liquidations.
    for (const p of gcPlan) {
      const days = Math.max(
        0,
        Math.floor((p.saleDate.getTime() - p.acquiredDate.getTime()) / 86_400_000),
      );
      await tx.liquidationEvent.create({
        data: {
          inventoryAssetId: p.assetId,
          date: p.saleDate,
          buyer: p.buyer,
          realizedRevenue: p.revenue,
          profit: p.revenue - p.acquisitionCost,
          daysToLiquidation: days,
          notes: null,
        },
      });
      await tx.inventoryAsset.update({
        where: { id: p.assetId },
        data: { status: "LIQUIDATED" },
      });
    }
    console.log(`Created ${gcPlan.length} GC LiquidationEvent rows`);

    // 6. Replay fuel liquidations. The schema enforces one
    // LiquidationEvent per InventoryAsset, so when an event needs less than
    // the asset's full quantity, we split: the original ID keeps the sold
    // portion (and gets the LiquidationEvent), and a new tail row holds
    // the remainder for the next event to consume.
    //
    // We track the "current head id" for each original asset across
    // sequential events. After a full liquidation of the head, the next
    // pull from that asset uses the new tail id.
    let fuelLineCount = 0;
    const headIdByOrig = new Map<string, string>(
      fuelAssetsPool.map((a) => [a.id, a.id]),
    );
    const remainingByOrig = new Map<string, number>(
      fuelAssetsPool.map((a) => [a.id, a.quantity]),
    );

    for (const ev of fuelEvents) {
      let need = ev.qty;
      let revenueRemaining = ev.revenue;
      for (const orig of fuelAssetsPool) {
        if (need <= 0) break;
        const left = remainingByOrig.get(orig.id) ?? 0;
        if (left <= 0) continue;
        const take = Math.min(left, need);
        const ratio = take / ev.qty;
        const lineRevenue =
          take === need
            ? revenueRemaining
            : Number((ev.revenue * ratio).toFixed(2));

        const currentId = headIdByOrig.get(orig.id)!;
        const cur = await tx.inventoryAsset.findUniqueOrThrow({
          where: { id: currentId },
        });
        let liquidateId = currentId;

        if (cur.quantity > take + 1e-6) {
          const splitRatio = take / cur.quantity;
          const headCost = cur.acquisitionCost * splitRatio;
          const headExpected = cur.expectedLiquidationValue * splitRatio;
          await tx.inventoryAsset.update({
            where: { id: cur.id },
            data: {
              quantity: take,
              acquisitionCost: headCost,
              expectedLiquidationValue: headExpected,
            },
          });
          const tail = await tx.inventoryAsset.create({
            data: {
              type: cur.type,
              subType: cur.subType,
              status: "HELD",
              quantity: cur.quantity - take,
              acquisitionCost: cur.acquisitionCost - headCost,
              expectedLiquidationValue: cur.expectedLiquidationValue - headExpected,
              acquiredDate: cur.acquiredDate,
              sourceTransactionId: cur.sourceTransactionId,
            },
          });
          headIdByOrig.set(orig.id, tail.id);
          liquidateId = cur.id;
        }

        const days = Math.max(
          0,
          Math.floor(
            (ev.date.getTime() - orig.acquiredDate.getTime()) / 86_400_000,
          ),
        );
        const lineCost = orig.acquisitionCost * (take / orig.quantity);
        await tx.liquidationEvent.create({
          data: {
            inventoryAssetId: liquidateId,
            date: ev.date,
            buyer: ev.buyer,
            realizedRevenue: lineRevenue,
            profit: lineRevenue - lineCost,
            daysToLiquidation: days,
            notes: null,
          },
        });
        await tx.inventoryAsset.update({
          where: { id: liquidateId },
          data: { status: "LIQUIDATED" },
        });
        remainingByOrig.set(orig.id, left - take);
        need -= take;
        revenueRemaining -= lineRevenue;
        fuelLineCount += 1;
      }
      if (need > 1e-6) {
        throw new Error(
          `Fuel pool exhausted for ${ev.buyer} ${ev.qty}; short by ${need}`,
        );
      }
    }
    console.log(`Created ${fuelLineCount} fuel LiquidationEvent rows`);
  });

  // Verify post-state.
  const postGc = await prisma.liquidationEvent.aggregate({
    _sum: { realizedRevenue: true },
    where: { inventoryAsset: { type: "GIFT_CARD" } },
  });
  const postFuel = await prisma.liquidationEvent.aggregate({
    _sum: { realizedRevenue: true },
    where: { inventoryAsset: { type: "FUEL_POINTS" } },
  });
  console.log(`\n--- After ---`);
  console.log(`GC revenue:   ${fmtUsd(postGc._sum.realizedRevenue ?? 0)}`);
  console.log(`Fuel revenue: ${fmtUsd(postFuel._sum.realizedRevenue ?? 0)}`);
  console.log(`Total:        ${fmtUsd((postGc._sum.realizedRevenue ?? 0) + (postFuel._sum.realizedRevenue ?? 0))}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
