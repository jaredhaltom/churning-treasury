import { VelocityWidget } from "@/components/velocity-widget";
import { WorkingCapital } from "@/components/working-capital";
import { KingSoopersForm } from "@/components/king-soopers-form";
import { CardsManager } from "@/components/cards-manager";
import { PlaidLinkButton } from "@/components/plaid-link-button";
import { Inbox, type InboxRow } from "@/components/inbox";
import { RecentRuns, type RunRow } from "@/components/recent-runs";
import { LiquidationDrawer } from "@/components/liquidation-drawer";
import { prisma } from "@/lib/prisma";
import { isPlaidSandboxConfigured, primaryPlaidEnv } from "@/lib/plaid";
import { IS_DEMO } from "@/lib/demo";
import { ASSET_STATUS, ASSET_TYPE, PROCEEDS_TYPE } from "@/lib/constants";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Coins, Wallet, PiggyBank, Plane } from "lucide-react";

export const dynamic = "force-dynamic";

async function getPortfolioStats() {
  const [heldFuel, heldMR, realizedCash, lifetimeCashback, redeemedMr] = await Promise.all([
    prisma.inventoryAsset.aggregate({
      _sum: { quantity: true, expectedLiquidationValue: true },
      where: {
        type: ASSET_TYPE.FUEL_POINTS,
        status: { not: ASSET_STATUS.LIQUIDATED },
      },
    }),
    prisma.inventoryAsset.aggregate({
      _sum: { quantity: true, expectedLiquidationValue: true },
      where: {
        type: ASSET_TYPE.MR_POINTS,
        status: { not: ASSET_STATUS.LIQUIDATED },
      },
    }),
    prisma.liquidationEvent.aggregate({
      _sum: { realizedRevenue: true, profit: true },
      _count: true,
      where: { proceedsType: PROCEEDS_TYPE.CASH },
    }),
    // Venmo 9% lifetime: cashback is "already liquid" (acquisitionCost = 0)
    // so we count the full inventory regardless of liquidation status. Filter
    // by subType=VENMO so Aspire/whatever else doesn't pollute it later.
    prisma.inventoryAsset.aggregate({
      _sum: { quantity: true },
      _count: true,
      where: { type: ASSET_TYPE.CASHBACK, subType: "VENMO" },
    }),
    prisma.inventoryAsset.aggregate({
      _sum: {
        quantity: true,
      },
      where: {
        type: ASSET_TYPE.MR_POINTS,
        liquidation: { is: { proceedsType: PROCEEDS_TYPE.NON_CASH } },
      },
    }),
  ]);
  const redeemedMrValue = await prisma.liquidationEvent.aggregate({
    _sum: { realizedRevenue: true },
    _count: true,
    where: {
      proceedsType: PROCEEDS_TYPE.NON_CASH,
      inventoryAsset: { type: ASSET_TYPE.MR_POINTS },
    },
  });

  return {
    fuelPoints: heldFuel._sum.quantity ?? 0,
    fuelValue: heldFuel._sum.expectedLiquidationValue ?? 0,
    mrPoints: heldMR._sum.quantity ?? 0,
    mrValue: heldMR._sum.expectedLiquidationValue ?? 0,
    lifetimeRevenue: realizedCash._sum.realizedRevenue ?? 0,
    lifetimeProfit: realizedCash._sum.profit ?? 0,
    liquidationCount: realizedCash._count,
    venmoCashback: lifetimeCashback._sum.quantity ?? 0,
    venmoRunCount: lifetimeCashback._count,
    redeemedMrPoints: redeemedMr._sum.quantity ?? 0,
    redeemedMrValue: redeemedMrValue._sum.realizedRevenue ?? 0,
    redeemedMrCount: redeemedMrValue._count,
  };
}

async function getCards() {
  // Pull cards + ids of cards that already have a SUB transaction (means
  // signup-bonus inventory has been minted, so we hide the "Mark SUB" CTA).
  const [cards, subTxns] = await Promise.all([
    prisma.card.findMany({
      orderBy: [{ closed: "asc" }, { openDate: "desc" }],
    }),
    prisma.transaction.findMany({
      where: { merchant: "Amex SUB" },
      select: { cardId: true },
    }),
  ]);
  const subbedCardIds = new Set(subTxns.map((t) => t.cardId));
  return cards.map((c) => ({ ...c, subMinted: subbedCardIds.has(c.id) }));
}

async function getLastSyncedAt(): Promise<Date | null> {
  const latest = await prisma.plaidItem.findFirst({
    orderBy: { lastSyncedAt: "desc" },
    select: { lastSyncedAt: true },
  });
  return latest?.lastSyncedAt ?? null;
}

async function getRecentRuns(): Promise<RunRow[]> {
  const rows = await prisma.transaction.findMany({
    where: {
      merchant: "King Soopers",
      // Only surface true MS runs: rows that produced inventory. Plaid may
      // also categorize an everyday $5 grocery run as "King Soopers" — those
      // have no assets and would just clutter this panel.
      assets: { some: {} },
    },
    orderBy: { date: "desc" },
    take: 30,
    include: {
      card: { select: { id: true, type: true, nickname: true } },
      assets: {
        include: { liquidation: { select: { id: true } } },
      },
    },
  });
  return rows.map((r) => {
    const gc = r.assets.find((a) => a.type === ASSET_TYPE.GIFT_CARD);
    const fuel = r.assets.find((a) => a.type === ASSET_TYPE.FUEL_POINTS);
    const mr = r.assets.find((a) => a.type === ASSET_TYPE.MR_POINTS);
    const cashback = r.assets.find((a) => a.type === ASSET_TYPE.CASHBACK);
    // Use GC face for the multiplier, not txn amount: Plaid-reconciled rows
    // store the real card charge (face + drink + tax), which would make a
    // 4x run look like 3.99x.
    const faceValue = gc?.quantity ?? r.amount;
    return {
      id: r.id,
      date: r.date.toISOString(),
      amount: r.amount,
      notes: r.notes,
      plaidTransactionId: r.plaidTransactionId,
      cardId: r.card.id,
      cardLabel: r.card.nickname ?? r.card.type,
      cardType: r.card.type,
      fuelMultiplier: fuel && faceValue > 0 ? fuel.quantity / faceValue : null,
      fuelRatePerPoint:
        fuel && fuel.quantity > 0 ? fuel.expectedLiquidationValue / fuel.quantity : null,
      liquidationRate:
        gc && gc.quantity > 0 ? gc.expectedLiquidationValue / gc.quantity : null,
      anyLiquidated: r.assets.some((a) => a.liquidation),
      breakdown: {
        giftCardFace: gc?.quantity ?? null,
        fuelPoints: fuel?.quantity ?? null,
        mrPoints: mr?.quantity ?? null,
        cashbackDollars: cashback?.quantity ?? null,
      },
    };
  });
}

async function getInboxRows(): Promise<InboxRow[]> {
  const rows = await prisma.transaction.findMany({
    where: { status: "PLAID_UNRECONCILED" },
    orderBy: { date: "desc" },
    include: { card: true },
  });

  // For each inbox row, surface manual entries on the same card that aren't
  // yet linked to a Plaid txn -- these are link candidates.
  const manualByCard = new Map<
    string,
    Array<{ id: string; date: Date; merchant: string; amount: number }>
  >();
  const cardIds = [...new Set(rows.map((r) => r.cardId))];
  if (cardIds.length > 0) {
    const manuals = await prisma.transaction.findMany({
      where: {
        cardId: { in: cardIds },
        plaidTransactionId: null,
        status: "MANUAL_UNMATCHED",
      },
      orderBy: { date: "desc" },
    });
    for (const m of manuals) {
      const arr = manualByCard.get(m.cardId) ?? [];
      arr.push({ id: m.id, date: m.date, merchant: m.merchant, amount: m.amount });
      manualByCard.set(m.cardId, arr);
    }
  }

  return rows.map((r): InboxRow => {
    const likelyMS =
      /kroger|king soopers|kingsoopers/i.test(r.merchant) && r.amount >= 500;
    const candidates = (manualByCard.get(r.cardId) ?? [])
      // prefer temporally close manual entries (within 14 days)
      .filter((m) => Math.abs(m.date.getTime() - r.date.getTime()) < 1000 * 60 * 60 * 24 * 14)
      .sort(
        (a, b) =>
          Math.abs(a.date.getTime() - r.date.getTime()) -
          Math.abs(b.date.getTime() - r.date.getTime()),
      )
      .slice(0, 5)
      .map((m) => ({
        id: m.id,
        date: m.date.toISOString(),
        merchant: m.merchant,
        amount: m.amount,
      }));

    return {
      id: r.id,
      date: r.date.toISOString(),
      merchant: r.merchant,
      amount: r.amount,
      category: r.category,
      cardId: r.cardId,
      cardLabel: r.card.nickname ?? r.card.type,
      likelyMS,
      candidateManualMatches: candidates,
    };
  });
}

function formatRelativeTime(date: Date | null): string {
  if (!date) return "never";
  const ms = Date.now() - date.getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

export default async function DashboardPage() {
  const [stats, cards, inboxRows, runs, lastSyncedAt] = await Promise.all([
    getPortfolioStats(),
    getCards(),
    getInboxRows(),
    getRecentRuns(),
    getLastSyncedAt(),
  ]);

  const openCards = cards.filter((c) => !c.closed);
  const cardOptionsForForm = openCards.map((c) => ({
    id: c.id,
    type: c.type,
    nickname: c.nickname,
  }));

  const cardRowsForManager = cards.map((c) => ({
    id: c.id,
    type: c.type,
    nickname: c.nickname,
    openDate: c.openDate.toISOString(),
    spendTarget: c.spendTarget,
    currentSpend: c.currentSpend,
    cooldownDays: c.cooldownDays,
    closed: c.closed,
    subMinted: c.subMinted,
    signupBonus: c.signupBonus,
  }));

  const plaidCardOptions = cards.map((c) => ({
    id: c.id,
    label: c.nickname ? `${c.nickname} (${c.type})` : c.type,
    plaidAccountId: c.plaidAccountId,
  }));

  return (
    <main className="mx-auto min-h-screen w-full max-w-7xl px-6 py-8">
      <header className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
            <Activity className="h-3.5 w-3.5" /> Churning Treasury
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {cards.length === 0
              ? "New here? Click Connect bank — Plaid will discover your cards."
              : "Track working capital across cards, gift cards, fuel points, and MR."}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <LiquidationDrawer />
            {IS_DEMO ? (
              <span className="rounded-md border border-dashed border-border bg-secondary/40 px-2.5 py-1 text-[11px] text-muted-foreground">
                Plaid integration disabled in demo mode
              </span>
            ) : (
              <PlaidLinkButton
                cards={plaidCardOptions}
                sandboxAvailable={
                  primaryPlaidEnv() !== "sandbox" && isPlaidSandboxConfigured()
                }
              />
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Last Plaid sync: {IS_DEMO ? "n/a (demo)" : formatRelativeTime(lastSyncedAt)}
          </p>
        </div>
      </header>

      <section className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-5">
        <StatCard
          icon={<Coins className="h-4 w-4 text-muted-foreground" />}
          label="Fuel points held"
          primary={`${formatNumber(stats.fuelPoints)} pts`}
          secondary={`~${formatCurrency(stats.fuelValue)} expected`}
        />
        <StatCard
          icon={<Coins className="h-4 w-4 text-muted-foreground" />}
          label="MR points held"
          primary={`${formatNumber(stats.mrPoints)} MR`}
          secondary={`~${formatCurrency(stats.mrValue)} @ 1.3cpp`}
        />
        <StatCard
          icon={<PiggyBank className="h-4 w-4 text-muted-foreground" />}
          label="Venmo 9% lifetime"
          primary={formatCurrency(stats.venmoCashback)}
          secondary={`${stats.venmoRunCount} run${stats.venmoRunCount === 1 ? "" : "s"} · already liquid`}
        />
        <StatCard
          icon={<Plane className="h-4 w-4 text-muted-foreground" />}
          label="MR redeemed (non-cash)"
          primary={formatCurrency(stats.redeemedMrValue)}
          secondary={`${formatNumber(stats.redeemedMrPoints)} MR across ${stats.redeemedMrCount} redemption${stats.redeemedMrCount === 1 ? "" : "s"}`}
        />
        <StatCard
          icon={<Wallet className="h-4 w-4 text-muted-foreground" />}
          label="Lifetime cash P&L"
          primary={formatCurrency(stats.lifetimeProfit)}
          secondary={`${stats.liquidationCount} liquidations, ${formatCurrency(
            stats.lifetimeRevenue,
          )} cash revenue`}
        />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4">
          <VelocityWidget />
          <CardsManager cards={cardRowsForManager} />
        </div>
        <div className="space-y-4 lg:col-span-1">
          <WorkingCapital />
          <Inbox rows={inboxRows} />
        </div>
        <div className="space-y-4 lg:col-span-1">
          <KingSoopersForm cards={cardOptionsForForm} />
          <RecentRuns initialRuns={runs} />
        </div>
      </section>
    </main>
  );
}

function StatCard({
  icon,
  label,
  primary,
  secondary,
}: {
  icon: React.ReactNode;
  label: string;
  primary: string;
  secondary: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-1.5">
          {icon}
          {label}
        </CardDescription>
        <CardTitle className="font-mono text-2xl">{primary}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{secondary}</p>
      </CardContent>
    </Card>
  );
}
