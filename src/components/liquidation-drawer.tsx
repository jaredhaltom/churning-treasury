"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  DollarSign,
  Loader2,
  TrendingDown,
  Coins,
  CreditCard,
  Receipt,
  X,
} from "lucide-react";
import {
  ASSET_TYPE,
  MR_DEFAULT_REDEMPTION_RATE,
  MR_DEFAULT_SALE_RATE,
  PROCEEDS_TYPE,
} from "@/lib/constants";
import { formatCurrency, formatNumber } from "@/lib/utils";

interface InventoryRow {
  id: string;
  type: string;
  subType: string | null;
  status: string;
  quantity: number;
  acquisitionCost: number;
  expectedLiquidationValue: number;
  acquiredDate: string;
  cardLabel: string | null;
}

interface InventoryAggregate {
  type: string;
  quantity: number;
  acquisitionCost: number;
  expectedLiquidationValue: number;
  count: number;
}

interface LiquidationEventRow {
  id: string;
  date: string;
  buyer: string;
  proceedsType: string;
  realizedRevenue: number;
  profit: number;
  daysToLiquidation: number;
  notes: string | null;
  asset: {
    id: string;
    type: string;
    subType: string | null;
    quantity: number;
    acquisitionCost: number;
  };
}

const ASSET_LABELS: Record<string, string> = {
  GIFT_CARD: "Gift cards (BBY)",
  FUEL_POINTS: "Fuel points",
  MR_POINTS: "MR points",
  CASHBACK: "Cashback",
};

const ASSET_UNITS: Record<string, string> = {
  GIFT_CARD: "$ face",
  FUEL_POINTS: "pts",
  MR_POINTS: "MR",
  CASHBACK: "$",
};

const DEFAULT_BUYER: Record<string, string> = {
  GIFT_CARD: "Aligned Incentives",
  FUEL_POINTS: "Kroger Fuel",
  MR_POINTS: "Transfer partner",
  CASHBACK: "Venmo",
};

export function LiquidationDrawer() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [aggregates, setAggregates] = React.useState<InventoryAggregate[]>([]);
  const [rows, setRows] = React.useState<InventoryRow[]>([]);
  const [events, setEvents] = React.useState<LiquidationEventRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [mrSaleRate, setMrSaleRate] = React.useState(MR_DEFAULT_SALE_RATE);
  const [mrRedemptionRate, setMrRedemptionRate] = React.useState(
    MR_DEFAULT_REDEMPTION_RATE,
  );
  const [savingRates, setSavingRates] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [invRes, evRes] = await Promise.all([
        fetch("/api/inventory"),
        fetch("/api/liquidations"),
      ]);
      if (!invRes.ok) throw new Error("Failed to load inventory");
      const inv = await invRes.json();
      setAggregates(inv.aggregates);
      setRows(inv.rows);
      if (evRes.ok) {
        const ev = await evRes.json();
        setEvents(ev.events);
      }
      const ratesRes = await fetch("/api/settings/mr-rates");
      if (ratesRes.ok) {
        const rates = await ratesRes.json();
        if (typeof rates.saleRate === "number") setMrSaleRate(rates.saleRate);
        if (typeof rates.redemptionRate === "number") {
          setMrRedemptionRate(rates.redemptionRate);
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  async function saveRates() {
    setSavingRates(true);
    setErr(null);
    try {
      const res = await fetch("/api/settings/mr-rates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          saleRate: mrSaleRate,
          redemptionRate: mrRedemptionRate,
        }),
      });
      if (!res.ok) throw new Error("Failed to save MR settings");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save MR settings");
    } finally {
      setSavingRates(false);
    }
  }

  React.useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <DollarSign className="h-3.5 w-3.5" /> Liquidate
      </Button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg">
            <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
              <div>
                <h3 className="text-base font-semibold">Liquidate inventory</h3>
                <p className="text-xs text-muted-foreground">
                  Sell held assets, or record an expiry as a $0 sale.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              {loading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading...
                </div>
              )}
              {err && (
                <p className="rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
                  {err}
                </p>
              )}

              {!loading && (
                <>
                  <BulkSellSection
                    aggregates={aggregates}
                    mrSaleRate={mrSaleRate}
                    mrRedemptionRate={mrRedemptionRate}
                    onCommit={async () => {
                      await refresh();
                      router.refresh();
                    }}
                  />
                  <section className="rounded-lg border border-border/60 bg-secondary/20 p-3">
                    <h4 className="mb-2 text-sm font-medium">MR defaults</h4>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <div className="space-y-1">
                        <Label className="text-[10px]">Sale rate (cpp)</Label>
                        <Input
                          type="number"
                          min="0.1"
                          step="0.01"
                          value={(mrSaleRate * 100).toFixed(2)}
                          onChange={(e) =>
                            setMrSaleRate(Math.max(0.001, Number(e.target.value) / 100))
                          }
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px]">Flight redeem rate (cpp)</Label>
                        <Input
                          type="number"
                          min="0.1"
                          step="0.01"
                          value={(mrRedemptionRate * 100).toFixed(2)}
                          onChange={(e) =>
                            setMrRedemptionRate(
                              Math.max(0.001, Number(e.target.value) / 100),
                            )
                          }
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="flex items-end">
                        <Button
                          size="sm"
                          onClick={saveRates}
                          disabled={savingRates}
                          className="w-full"
                        >
                          {savingRates ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : null}
                          Save defaults
                        </Button>
                      </div>
                    </div>
                  </section>
                  <PerRowSellSection
                    rows={rows.filter((r) => r.type === ASSET_TYPE.GIFT_CARD)}
                    onCommit={async () => {
                      await refresh();
                      router.refresh();
                    }}
                  />
                  <RecentLiquidations events={events} />
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function BulkSellSection({
  aggregates,
  mrSaleRate,
  mrRedemptionRate,
  onCommit,
}: {
  aggregates: InventoryAggregate[];
  mrSaleRate: number;
  mrRedemptionRate: number;
  onCommit: () => Promise<void>;
}) {
  const fuel = aggregates.find((a) => a.type === ASSET_TYPE.FUEL_POINTS);
  const mr = aggregates.find((a) => a.type === ASSET_TYPE.MR_POINTS);
  const cashback = aggregates.find((a) => a.type === ASSET_TYPE.CASHBACK);

  const fungible = [fuel, mr, cashback].filter((a): a is InventoryAggregate => Boolean(a));

  if (fungible.length === 0) return null;

  return (
    <section className="space-y-3">
      <h4 className="flex items-center gap-2 text-sm font-medium">
        <Coins className="h-4 w-4 text-muted-foreground" />
        Bulk sell (fungible)
      </h4>
      <div className="space-y-3">
        {fungible.map((agg) => (
          <BulkSellRow
            key={agg.type}
            agg={agg}
            mrSaleRate={mrSaleRate}
            mrRedemptionRate={mrRedemptionRate}
            onCommit={onCommit}
          />
        ))}
      </div>
    </section>
  );
}

function BulkSellRow({
  agg,
  mrSaleRate,
  mrRedemptionRate,
  onCommit,
}: {
  agg: InventoryAggregate;
  mrSaleRate: number;
  mrRedemptionRate: number;
  onCommit: () => Promise<void>;
}) {
  const [mode, setMode] = React.useState<
    "idle" | "sell" | "expire" | "redeem" | "brokered"
  >(
    "idle",
  );
  const [qty, setQty] = React.useState<string>("");
  const [revenue, setRevenue] = React.useState<string>("");
  const [buyer, setBuyer] = React.useState<string>(DEFAULT_BUYER[agg.type] ?? "");
  const [notes, setNotes] = React.useState<string>("");
  const [rebateOn, setRebateOn] = React.useState(true);
  const [rebatePct, setRebatePct] = React.useState("35");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  function startSell() {
    setMode("sell");
    setQty(agg.quantity.toString());
    setRevenue(
      agg.type === ASSET_TYPE.MR_POINTS
        ? (agg.quantity * mrSaleRate).toFixed(2)
        : agg.expectedLiquidationValue.toFixed(2),
    );
    setBuyer(DEFAULT_BUYER[agg.type] ?? "");
    setNotes("");
    setErr(null);
  }
  function startRedeem() {
    setMode("redeem");
    setQty(agg.quantity.toString());
    setRevenue((agg.quantity * mrRedemptionRate).toFixed(2));
    setBuyer("Flight redemption");
    setNotes("Non-cash MR redemption");
    setRebateOn(true);
    setRebatePct("35");
    setErr(null);
  }
  function startBrokered() {
    setMode("brokered");
    setQty(agg.quantity.toString());
    setRevenue((agg.quantity * mrSaleRate).toFixed(2));
    setBuyer("Broker");
    setNotes("Brokered redemption (cash + rebate)");
    setRebateOn(true);
    setRebatePct("35");
    setErr(null);
  }
  function startExpire() {
    setMode("expire");
    setQty("");
    setRevenue("0");
    setBuyer("Expired");
    setNotes("Inventory expired / not sold");
    setErr(null);
  }

  async function commit() {
    setBusy(true);
    setErr(null);
    try {
      const q = Number(qty);
      const r = Number(revenue);
      if (!Number.isFinite(q) || q <= 0) throw new Error("Quantity must be > 0");
      if (!Number.isFinite(r) || r < 0) throw new Error("Revenue must be ≥ 0");
      const res = await fetch("/api/liquidations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "bulk",
          type: agg.type,
          quantity: q,
          realizedRevenue: r,
          proceedsType:
            mode === "redeem" ? PROCEEDS_TYPE.NON_CASH : PROCEEDS_TYPE.CASH,
          rebateRate:
            (mode === "redeem" || mode === "brokered") && rebateOn
              ? Math.max(0, Number(rebatePct) / 100)
              : undefined,
          buyer: buyer || "Unknown",
          notes,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed");
      }
      setMode("idle");
      await onCommit();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const unit = ASSET_UNITS[agg.type] ?? "";

  return (
    <div className="rounded-lg border border-border/60 bg-secondary/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{ASSET_LABELS[agg.type] ?? agg.type}</div>
          <div className="text-[11px] text-muted-foreground">
            {formatNumber(agg.quantity)} {unit} held across {agg.count} row
            {agg.count === 1 ? "" : "s"} · expected{" "}
            {formatCurrency(agg.expectedLiquidationValue)}
          </div>
        </div>
        {mode === "idle" && (
          <div className="flex gap-1.5">
            <Button size="sm" variant="secondary" onClick={startSell}>
              Sell
            </Button>
            {agg.type === ASSET_TYPE.MR_POINTS && (
              <Button size="sm" variant="outline" onClick={startRedeem}>
                Redeem
              </Button>
            )}
            {agg.type === ASSET_TYPE.MR_POINTS && (
              <Button size="sm" variant="outline" onClick={startBrokered}>
                Brokered
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={startExpire}>
              <TrendingDown className="h-3 w-3" /> Expire
            </Button>
          </div>
        )}
      </div>

      {mode !== "idle" && (
        <div className="mt-3 space-y-2 rounded-md border border-border/60 bg-background/40 p-2.5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="space-y-1">
              <Label className="text-[10px]">Quantity ({unit})</Label>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px]">Revenue ($)</Label>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={revenue}
                onChange={(e) => setRevenue(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px]">Buyer</Label>
              <Input
                value={buyer}
                onChange={(e) => setBuyer(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px]">Notes</Label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>
          {(mode === "redeem" || mode === "brokered") &&
            agg.type === ASSET_TYPE.MR_POINTS && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="space-y-1">
                <Label className="text-[10px]">Rebate enabled</Label>
                <Select
                  value={rebateOn ? "yes" : "no"}
                  onChange={(e) => setRebateOn(e.target.value === "yes")}
                  className="h-8 text-xs"
                >
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[10px]">Rebate %</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="90"
                  step="0.1"
                  value={rebatePct}
                  onChange={(e) => setRebatePct(e.target.value)}
                  disabled={!rebateOn}
                  className="h-8 text-xs"
                />
              </div>
              <div className="col-span-2 flex items-end text-[10px] text-muted-foreground">
                {(() => {
                  const q = Number(qty) || 0;
                  const p = rebateOn ? Math.max(0, Number(rebatePct) / 100) : 0;
                  const back = q * p;
                  return `Rebate credit back to MR held: ${formatNumber(back)} MR`;
                })()}
              </div>
            </div>
          )}
          {err && <p className="text-[10px] text-destructive">{err}</p>}
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode("idle")}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={commit} disabled={busy}>
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : null}
              {mode === "expire"
                ? "Record expiry"
                : mode === "redeem"
                  ? "Record redemption"
                  : mode === "brokered"
                    ? "Record brokered sale"
                  : "Sell"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PerRowSellSection({
  rows,
  onCommit,
}: {
  rows: InventoryRow[];
  onCommit: () => Promise<void>;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="space-y-2">
      <h4 className="flex items-center gap-2 text-sm font-medium">
        <CreditCard className="h-4 w-4 text-muted-foreground" />
        Gift cards (one row = one card)
      </h4>
      <ul className="space-y-2">
        {rows.map((r) => (
          <PerRowItem key={r.id} row={r} onCommit={onCommit} />
        ))}
      </ul>
    </section>
  );
}

function PerRowItem({
  row,
  onCommit,
}: {
  row: InventoryRow;
  onCommit: () => Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [revenue, setRevenue] = React.useState<string>(
    row.expectedLiquidationValue.toFixed(2),
  );
  const [buyer, setBuyer] = React.useState<string>(DEFAULT_BUYER[row.type] ?? "");
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function commit() {
    setBusy(true);
    setErr(null);
    try {
      const r = Number(revenue);
      if (!Number.isFinite(r) || r < 0) throw new Error("Revenue must be ≥ 0");
      const res = await fetch("/api/liquidations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "single",
          assetId: row.id,
          realizedRevenue: r,
          buyer: buyer || "Unknown",
          notes,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed");
      }
      setEditing(false);
      await onCommit();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg border border-border/60 bg-secondary/30 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-sm">
            {formatCurrency(row.quantity)} {row.subType ?? ""}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Acquired {new Date(row.acquiredDate).toLocaleDateString()} · cost{" "}
            {formatCurrency(row.acquisitionCost)} · expected{" "}
            {formatCurrency(row.expectedLiquidationValue)}
          </div>
        </div>
        {!editing && (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            Sell
          </Button>
        )}
      </div>
      {editing && (
        <div className="mt-3 space-y-2 rounded-md border border-border/60 bg-background/40 p-2.5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-[10px]">Revenue ($)</Label>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={revenue}
                onChange={(e) => setRevenue(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px]">Buyer</Label>
              <Input
                value={buyer}
                onChange={(e) => setBuyer(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px]">Notes</Label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>
          {err && <p className="text-[10px] text-destructive">{err}</p>}
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={commit} disabled={busy}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Sell
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function RecentLiquidations({ events }: { events: LiquidationEventRow[] }) {
  if (events.length === 0) return null;
  return (
    <section className="space-y-2">
      <h4 className="flex items-center gap-2 text-sm font-medium">
        <Receipt className="h-4 w-4 text-muted-foreground" />
        Recent liquidations
      </h4>
      <ul className="space-y-1.5">
        {events.slice(0, 10).map((e) => (
          <li
            key={e.id}
            className="flex items-center justify-between gap-2 rounded border border-border/60 bg-secondary/20 px-2.5 py-1.5 text-[11px]"
          >
            <div className="min-w-0">
              <span className="font-mono">
                {formatNumber(e.asset.quantity)} {ASSET_UNITS[e.asset.type] ?? ""}
              </span>{" "}
              <span className="text-muted-foreground">
                {ASSET_LABELS[e.asset.type] ?? e.asset.type}
                {e.asset.subType ? ` · ${e.asset.subType}` : ""} · {e.buyer}
              </span>
              {e.proceedsType === PROCEEDS_TYPE.NON_CASH && (
                <span className="ml-1 rounded-full bg-accent px-1.5 py-0.5 text-[9px] text-muted-foreground">
                  non-cash
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono">{formatCurrency(e.realizedRevenue)}</span>
              <span
                className={
                  e.profit >= 0
                    ? "rounded-full bg-success/15 px-1.5 py-0.5 text-success"
                    : "rounded-full bg-destructive/15 px-1.5 py-0.5 text-destructive"
                }
              >
                {formatCurrency(e.profit)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
