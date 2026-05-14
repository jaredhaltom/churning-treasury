/**
 * Seed the public demo database with a fabricated-but-realistic churning
 * portfolio. Run by the Vercel build step against an empty
 * prisma/demo.db.
 *
 * The data must:
 *   - Light up every dashboard widget (Velocity, Working Capital, Inbox,
 *     Recent Runs, Cards Manager, stat tiles).
 *   - Use the exact business logic helpers (splitKingSoopersRun,
 *     ensureSubMrInventory, liquidateOne) so the demo math matches prod math.
 *   - Be deterministic — same input, same demo across builds — so we can
 *     screenshot it predictably.
 *
 * Usage (from the churning-app/ directory):
 *
 *   DATABASE_URL=file:./prisma/demo.db tsx scripts/seed-demo.ts
 *
 * Safe to re-run: the script wipes all tables before inserting.
 */

// Important: import the singleton prisma client so that helpers in
// inventory-ops (which call prisma.$transaction on their OWN import of the
// singleton) write to the same connection we do. Two clients pointing at the
// same SQLite file would technically work but invite WAL / locking races.
//
// We rely on DATABASE_URL=file:./prisma/demo.db being set in the environment
// when this script runs. NEXT_PUBLIC_DEMO_MODE is intentionally NOT set so
// the singleton skips its /tmp bootstrap path.
import { prisma } from "../src/lib/prisma";
import {
  ASSET_STATUS,
  ASSET_TYPE,
  CARD_SPECS,
  CARD_TYPE,
  FUEL_POINT_VALUE_MID,
  MR_POINT_VALUE,
  PROCEEDS_TYPE,
  splitKingSoopersRun,
  type CardType,
} from "../src/lib/constants";
import { ensureSubMrInventory, liquidateOne } from "../src/lib/inventory-ops";

// Deterministic PRNG so the demo dataset is reproducible across builds.
// Mulberry32 — same seed in, same sequence out. Don't change the seed unless
// you want different demo data forever after.
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260514);

function pickInt(min: number, max: number): number {
  return Math.floor(rnd() * (max - min + 1)) + min;
}
function pickRange(min: number, max: number): number {
  return rnd() * (max - min) + min;
}
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function wipe() {
  // Order matters: respect FK dependencies (LiquidationEvent -> InventoryAsset
  // -> Transaction -> Card; PlaidItem is independent).
  await prisma.liquidationEvent.deleteMany();
  await prisma.inventoryAsset.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.plaidItem.deleteMany();
  await prisma.card.deleteMany();
  await prisma.appSetting.deleteMany();
}

interface CardSeed {
  type: CardType;
  nickname: string;
  openDaysAgo: number;
  currentSpend: number;
  closed?: boolean;
  signupBonus?: number;
}

const CARDS: CardSeed[] = [
  {
    type: CARD_TYPE.ABP,
    nickname: "Platinum #1",
    openDaysAgo: 140,
    currentSpend: 20_000,
  },
  {
    type: CARD_TYPE.ABP,
    nickname: "Platinum #2",
    openDaysAgo: 45,
    currentSpend: 12_400,
  },
  {
    type: CARD_TYPE.ABG,
    nickname: "Gold (family)",
    openDaysAgo: 95,
    currentSpend: 15_000,
  },
  {
    type: CARD_TYPE.VENMO,
    nickname: "Venmo CC",
    openDaysAgo: 220,
    currentSpend: 0,
  },
  {
    type: CARD_TYPE.OTHER,
    nickname: "Aspire",
    openDaysAgo: 60,
    currentSpend: 4_300,
  },
  {
    type: CARD_TYPE.OTHER,
    nickname: "Sapphire (closed)",
    openDaysAgo: 410,
    currentSpend: 8_000,
    closed: true,
  },
];

async function createCards() {
  const created: Array<{ seed: CardSeed; id: string }> = [];
  for (const seed of CARDS) {
    const spec =
      seed.type === CARD_TYPE.OTHER
        ? { spendTarget: 0, cooldownDays: 0 }
        : CARD_SPECS[seed.type];
    const card = await prisma.card.create({
      data: {
        type: seed.type,
        nickname: seed.nickname,
        openDate: daysAgo(seed.openDaysAgo),
        spendTarget: spec.spendTarget,
        cooldownDays: spec.cooldownDays,
        currentSpend: seed.currentSpend,
        signupBonus: seed.signupBonus ?? 0,
        closed: seed.closed ?? false,
      },
    });
    created.push({ seed, id: card.id });
  }
  return created;
}

interface KSRunInput {
  cardId: string;
  cardType: CardType;
  faceValue: number;
  daysAgo: number;
  fuelMultiplier: number;
  liquidationRate: number;
  notes?: string;
}

async function createKingSoopersRun(input: KSRunInput) {
  const split = splitKingSoopersRun({
    dollars: input.faceValue,
    cardType: input.cardType,
    fuelMultiplier: input.fuelMultiplier,
    liquidationRate: input.liquidationRate,
    fuelRate: FUEL_POINT_VALUE_MID,
  });
  const date = daysAgo(input.daysAgo);
  return prisma.$transaction(async (tx) => {
    const txn = await tx.transaction.create({
      data: {
        cardId: input.cardId,
        date,
        merchant: "King Soopers",
        amount: input.faceValue,
        notes: input.notes ?? null,
      },
    });
    const seeds = [split.giftCard, split.fuelPoints, split.cashback, split.mrPoints].filter(
      (s): s is NonNullable<typeof s> => Boolean(s),
    );
    const assets = await Promise.all(
      seeds.map((s) =>
        tx.inventoryAsset.create({
          data: { ...s, sourceTransactionId: txn.id, acquiredDate: date },
        }),
      ),
    );
    return { txn, assets };
  });
}

async function seedRuns(cards: Array<{ seed: CardSeed; id: string }>) {
  const allAssets: Array<{ id: string; type: string; subType: string | null; daysAgo: number }> = [];

  // Platinum #1: 10 runs over the last 130 days, 4x or 5x promo
  const p1 = cards.find((c) => c.seed.nickname === "Platinum #1")!;
  for (let i = 0; i < 10; i++) {
    const d = 130 - i * 12 - pickInt(0, 3);
    const face = [500, 750, 1000, 1500, 2000][pickInt(0, 4)];
    const mult = rnd() < 0.7 ? 4 : 5;
    const liqRate = [0.91, 0.92, 0.93, 0.94][pickInt(0, 3)];
    const r = await createKingSoopersRun({
      cardId: p1.id,
      cardType: p1.seed.type,
      faceValue: face,
      daysAgo: d,
      fuelMultiplier: mult,
      liquidationRate: liqRate,
      notes: mult === 5 ? "5x promo" : undefined,
    });
    for (const a of r.assets) {
      allAssets.push({ id: a.id, type: a.type, subType: a.subType, daysAgo: d });
    }
  }

  // Platinum #2: 6 runs over last 40 days
  const p2 = cards.find((c) => c.seed.nickname === "Platinum #2")!;
  for (let i = 0; i < 6; i++) {
    const d = 38 - i * 6 - pickInt(0, 2);
    const face = [500, 1000, 1500, 2000][pickInt(0, 3)];
    const mult = rnd() < 0.5 ? 4 : 5;
    const liqRate = [0.92, 0.93, 0.94][pickInt(0, 2)];
    const r = await createKingSoopersRun({
      cardId: p2.id,
      cardType: p2.seed.type,
      faceValue: face,
      daysAgo: d,
      fuelMultiplier: mult,
      liquidationRate: liqRate,
    });
    for (const a of r.assets) {
      allAssets.push({ id: a.id, type: a.type, subType: a.subType, daysAgo: d });
    }
  }

  // Gold (family): 8 runs over the last 90 days. 4x MR per $ at KS for ABG.
  const ag = cards.find((c) => c.seed.nickname === "Gold (family)")!;
  for (let i = 0; i < 8; i++) {
    const d = 88 - i * 10 - pickInt(0, 3);
    const face = [500, 1000, 1500, 2000][pickInt(0, 3)];
    const mult = rnd() < 0.6 ? 4 : 5;
    const liqRate = [0.91, 0.92, 0.93][pickInt(0, 2)];
    const r = await createKingSoopersRun({
      cardId: ag.id,
      cardType: ag.seed.type,
      faceValue: face,
      daysAgo: d,
      fuelMultiplier: mult,
      liquidationRate: liqRate,
    });
    for (const a of r.assets) {
      allAssets.push({ id: a.id, type: a.type, subType: a.subType, daysAgo: d });
    }
  }

  // Venmo: 5 cashback-mode runs over 180 days (smaller amounts; Venmo is a
  // tax on Amex but earns 9% groceries cashback).
  const vn = cards.find((c) => c.seed.nickname === "Venmo CC")!;
  for (let i = 0; i < 5; i++) {
    const d = 170 - i * 25 - pickInt(0, 5);
    const face = [400, 500, 600, 700][pickInt(0, 3)];
    const r = await createKingSoopersRun({
      cardId: vn.id,
      cardType: vn.seed.type,
      faceValue: face,
      daysAgo: d,
      fuelMultiplier: 4,
      liquidationRate: 0.93,
    });
    for (const a of r.assets) {
      allAssets.push({ id: a.id, type: a.type, subType: a.subType, daysAgo: d });
    }
  }

  return allAssets;
}

async function mintSubs(cards: Array<{ seed: CardSeed; id: string }>) {
  // Cards that crossed spendTarget get SUB inventory minted via the canonical
  // path so the math matches production exactly.
  for (const c of cards) {
    if (c.seed.currentSpend >= (CARD_SPECS[c.seed.type as keyof typeof CARD_SPECS]?.spendTarget ?? Infinity)) {
      await ensureSubMrInventory(prisma, c.id);
    }
  }
}

async function liquidateSome(
  cards: Array<{ seed: CardSeed; id: string }>,
  assets: Array<{ id: string; type: string; subType: string | null; daysAgo: number }>,
) {
  // Liquidate the oldest ~60% of gift cards (Aligned Incentives), the oldest
  // ~50% of fuel points (split between Aligned Incentives and Kroger Fuel),
  // and redeem ~20% of MR for Amex Travel (non-cash).
  const giftCards = assets
    .filter((a) => a.type === ASSET_TYPE.GIFT_CARD)
    .sort((a, b) => b.daysAgo - a.daysAgo); // oldest first
  const fuels = assets
    .filter((a) => a.type === ASSET_TYPE.FUEL_POINTS)
    .sort((a, b) => b.daysAgo - a.daysAgo);
  const mrs = assets
    .filter((a) => a.type === ASSET_TYPE.MR_POINTS)
    .sort((a, b) => b.daysAgo - a.daysAgo);

  const gcTake = Math.floor(giftCards.length * 0.6);
  for (let i = 0; i < gcTake; i++) {
    const a = giftCards[i];
    const row = await prisma.inventoryAsset.findUnique({ where: { id: a.id } });
    if (!row) continue;
    // Realized rate jitter: most lots sell within +/- 0.5% of expected.
    const realizedRate = row.quantity > 0
      ? (row.expectedLiquidationValue / row.quantity) + pickRange(-0.005, 0.003)
      : 0.93;
    const revenue = Math.round(row.quantity * realizedRate * 100) / 100;
    // Liquidate 7-21 days after acquisition.
    const liqDaysAgo = Math.max(0, a.daysAgo - pickInt(7, 21));
    await liquidateOne({
      assetId: a.id,
      realizedRevenue: revenue,
      buyer: "Aligned Incentives",
      proceedsType: PROCEEDS_TYPE.CASH,
      date: daysAgo(liqDaysAgo),
    });
  }

  // Mark a couple of newer GCs as PENDING_SALE so the dashboard shows that
  // state. Skip if no candidates remain.
  for (let i = gcTake; i < Math.min(gcTake + 2, giftCards.length); i++) {
    await prisma.inventoryAsset.update({
      where: { id: giftCards[i].id },
      data: { status: ASSET_STATUS.PENDING_SALE },
    });
  }

  // Fuel: liquidate ~80% of the older lots. Without this the fuel-side
  // profit doesn't materialize as cash and the headline P&L undershoots.
  const fuelTake = Math.floor(fuels.length * 0.8);
  for (let i = 0; i < fuelTake; i++) {
    const a = fuels[i];
    const row = await prisma.inventoryAsset.findUnique({ where: { id: a.id } });
    if (!row) continue;
    const buyer = i % 3 === 0 ? "Kroger Fuel (self-use)" : "Aligned Incentives";
    const realizedPerPoint = FUEL_POINT_VALUE_MID + pickRange(-0.001, 0.001);
    const revenue = Math.round(row.quantity * realizedPerPoint * 100) / 100;
    const liqDaysAgo = Math.max(0, a.daysAgo - pickInt(5, 18));
    await liquidateOne({
      assetId: a.id,
      realizedRevenue: revenue,
      buyer,
      proceedsType: PROCEEDS_TYPE.CASH,
      date: daysAgo(liqDaysAgo),
    });
  }

  // MR redemptions: cash a few of the older per-run lots PLUS one big SUB
  // lot so the lifetime cash P&L reflects the value of the welcome bonuses
  // (otherwise SUB MR sits stuck in inventory and the headline number is
  // dominated by GC drag).
  const cashMrCount = Math.min(3, mrs.length);
  for (let i = 0; i < cashMrCount; i++) {
    const m = mrs[i];
    const row = await prisma.inventoryAsset.findUnique({ where: { id: m.id } });
    if (!row) continue;
    const revenue = Math.round(row.quantity * 0.0125 * 100) / 100;
    await liquidateOne({
      assetId: m.id,
      realizedRevenue: revenue,
      buyer: "MR points buyer",
      proceedsType: PROCEEDS_TYPE.CASH,
      date: daysAgo(Math.max(0, m.daysAgo - 10)),
    });
  }

  // Partially redeem one SUB lot via Amex Travel (non-cash). The SUB rows
  // weren't tracked in `assets` above (they were minted by ensureSubMrInventory
  // after seedRuns), so we look them up directly by subType prefix.
  const subRows = await prisma.inventoryAsset.findMany({
    where: {
      type: ASSET_TYPE.MR_POINTS,
      subType: { startsWith: "SUB-" },
      status: ASSET_STATUS.HELD,
    },
    orderBy: { quantity: "desc" },
    take: 2,
  });

  if (subRows.length > 0) {
    const big = subRows[0];
    const partial = Math.floor(big.quantity / 2);
    if (partial > 0) {
      const revenue = Math.round(partial * 0.018 * 100) / 100;
      await liquidateOne({
        assetId: big.id,
        quantity: partial,
        realizedRevenue: revenue,
        buyer: "Amex Travel (business class)",
        proceedsType: PROCEEDS_TYPE.NON_CASH,
        date: daysAgo(20),
      });
    }
  }

  if (subRows.length > 1) {
    // Sell ~30% of the second SUB lot for cash, so the lifetime cash P&L
    // includes a healthy SUB tailwind.
    const second = subRows[1];
    const partial = Math.floor(second.quantity * 0.3);
    if (partial > 0) {
      const revenue = Math.round(partial * 0.0125 * 100) / 100;
      await liquidateOne({
        assetId: second.id,
        quantity: partial,
        realizedRevenue: revenue,
        buyer: "MR points buyer",
        proceedsType: PROCEEDS_TYPE.CASH,
        date: daysAgo(30),
      });
    }
  }
}

async function seedInbox(cards: Array<{ seed: CardSeed; id: string }>) {
  // A handful of PLAID_UNRECONCILED rows so the Inbox widget isn't empty.
  // We use a fake plaidTransactionId so the schema's @unique constraint is
  // honored; the routes that touch real Plaid are 503'd in demo mode.
  const p1 = cards.find((c) => c.seed.nickname === "Platinum #1")!;
  const p2 = cards.find((c) => c.seed.nickname === "Platinum #2")!;
  const ag = cards.find((c) => c.seed.nickname === "Gold (family)")!;

  const inboxRows = [
    {
      cardId: p2.id,
      daysAgo: 3,
      merchant: "KING SOOPERS #0421",
      amount: 1004.78,
      category: "FOOD_AND_DRINK_GROCERIES",
    },
    {
      cardId: p1.id,
      daysAgo: 5,
      merchant: "KING SOOPERS #1882",
      amount: 506.12,
      category: "FOOD_AND_DRINK_GROCERIES",
    },
    {
      cardId: ag.id,
      daysAgo: 8,
      merchant: "Costco Wholesale",
      amount: 184.23,
      category: "FOOD_AND_DRINK_GROCERIES",
    },
    {
      cardId: p2.id,
      daysAgo: 11,
      merchant: "Amazon.com",
      amount: 47.99,
      category: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES",
    },
  ];

  for (let i = 0; i < inboxRows.length; i++) {
    const r = inboxRows[i];
    await prisma.transaction.create({
      data: {
        cardId: r.cardId,
        date: daysAgo(r.daysAgo),
        merchant: r.merchant,
        amount: r.amount,
        status: "PLAID_UNRECONCILED",
        category: r.category,
        plaidTransactionId: `demo-plaid-txn-${i + 1}`,
        plaidAccountId: `demo-plaid-acct-${i + 1}`,
      },
    });
  }
}

async function main() {
  console.log("[seed-demo] Wiping existing demo data…");
  await wipe();

  console.log("[seed-demo] Creating cards…");
  const cards = await createCards();

  console.log("[seed-demo] Creating King Soopers runs…");
  const assets = await seedRuns(cards);

  console.log("[seed-demo] Minting signup bonuses…");
  await mintSubs(cards);

  console.log("[seed-demo] Liquidating older inventory…");
  await liquidateSome(cards, assets);

  console.log("[seed-demo] Seeding inbox rows…");
  await seedInbox(cards);

  // Sanity stats for the build log.
  const [cardCount, txnCount, assetCount, liqCount] = await Promise.all([
    prisma.card.count(),
    prisma.transaction.count(),
    prisma.inventoryAsset.count(),
    prisma.liquidationEvent.count(),
  ]);
  const heldMr = await prisma.inventoryAsset.aggregate({
    _sum: { quantity: true },
    where: { type: ASSET_TYPE.MR_POINTS, status: { not: ASSET_STATUS.LIQUIDATED } },
  });
  const cashProfit = await prisma.liquidationEvent.aggregate({
    _sum: { profit: true },
    where: { proceedsType: PROCEEDS_TYPE.CASH },
  });
  console.log(
    `[seed-demo] Done. ${cardCount} cards, ${txnCount} transactions, ` +
      `${assetCount} assets, ${liqCount} liquidations. ` +
      `Held MR: ${(heldMr._sum.quantity ?? 0).toLocaleString()} ` +
      `(@${MR_POINT_VALUE} = ~$${((heldMr._sum.quantity ?? 0) * MR_POINT_VALUE).toFixed(0)}). ` +
      `Realized cash profit: $${(cashProfit._sum.profit ?? 0).toFixed(2)}.`,
  );
}

main()
  .catch((e) => {
    console.error("[seed-demo] Failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
