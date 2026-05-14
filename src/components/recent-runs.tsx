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
import { History, Loader2, Pencil, Trash2, Check, X, RefreshCw } from "lucide-react";
import { formatCurrency, formatNumber } from "@/lib/utils";

export interface RunRow {
  id: string;
  date: string; // ISO
  amount: number;
  notes: string | null;
  plaidTransactionId: string | null;
  cardId: string;
  cardLabel: string;
  cardType: string;
  fuelMultiplier: number | null;
  fuelRatePerPoint: number | null;
  liquidationRate: number | null;
  anyLiquidated: boolean;
  breakdown: {
    giftCardFace: number | null;
    fuelPoints: number | null;
    mrPoints: number | null;
    cashbackDollars: number | null;
  };
}

export function RecentRuns({ initialRuns = [] }: { initialRuns?: RunRow[] }) {
  const router = useRouter();
  const [runs, setRuns] = React.useState<RunRow[]>(initialRuns);
  const [refreshing, setRefreshing] = React.useState(false);

  // Re-sync from server when initialRuns prop updates (e.g. after router.refresh).
  React.useEffect(() => setRuns(initialRuns), [initialRuns]);

  async function refetch() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/king-soopers-run?limit=50");
      if (res.ok) {
        const data = await res.json();
        setRuns(data.runs);
      }
    } finally {
      setRefreshing(false);
    }
  }

  if (runs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            Recent runs
          </CardTitle>
          <CardDescription>No King Soopers runs logged yet.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            Recent runs
          </CardTitle>
          <CardDescription>
            Edit fuel multiplier or face value here if you logged something
            wrong (e.g. promo was 2x not 4x).
          </CardDescription>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={refetch}
          disabled={refreshing}
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {runs.map((r) => (
            <RunListItem
              key={r.id}
              run={r}
              onChanged={() => {
                refetch();
                router.refresh();
              }}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function RunListItem({ run, onChanged }: { run: RunRow; onChanged: () => void }) {
  // Headline number = gift card face. For Plaid-reconciled rows, run.amount
  // is the real card charge (face + drink + tax); breakdown.giftCardFace is
  // the face we actually care about. Fall back to amount for any pre-asset
  // rows that somehow snuck through.
  const faceValue = run.breakdown.giftCardFace ?? run.amount;
  const chargeDeltaCents = Math.round((run.amount - faceValue) * 100);
  const hasChargeDelta = run.plaidTransactionId !== null && chargeDeltaCents > 0;

  const [editing, setEditing] = React.useState(false);
  const [face, setFace] = React.useState(faceValue.toFixed(2));
  const [mult, setMult] = React.useState(() => {
    const m = run.fuelMultiplier ?? 4;
    // Round near-integers (e.g. 3.989 from a Plaid charge that includes a
    // drink) back to clean integers in the input.
    return Math.abs(m - Math.round(m)) < 0.05 ? Math.round(m).toString() : m.toFixed(2);
  });
  const [rate1k, setRate1k] = React.useState(
    ((run.fuelRatePerPoint ?? 0.0195) * 1000).toFixed(2),
  );
  const [liqPct, setLiqPct] = React.useState(
    ((run.liquidationRate ?? 0.925) * 100).toFixed(2),
  );
  const [busy, setBusy] = React.useState<"save" | "delete" | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const date = new Date(run.date);
  const locked = run.anyLiquidated;

  async function save() {
    setBusy("save");
    setErr(null);
    try {
      const res = await fetch(`/api/king-soopers-run/${run.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          faceValue: Number(face),
          fuelMultiplier: Number(mult),
          fuelRate: Number(rate1k) / 1000,
          liquidationRate: Number(liqPct) / 100,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Save failed");
      }
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!confirm(`Delete the ${formatCurrency(faceValue)} run from ${date.toLocaleDateString()}? This wipes its inventory rows.`)) return;
    setBusy("delete");
    setErr(null);
    try {
      const res = await fetch(`/api/king-soopers-run/${run.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Delete failed");
      }
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="rounded-lg border border-border/60 bg-secondary/30 p-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">{formatCurrency(faceValue)}</span>
            <span className="text-muted-foreground">·</span>
            <span>{date.toLocaleDateString()}</span>
            <span className="text-muted-foreground">·</span>
            <span className="truncate">{run.cardLabel}</span>
            {run.plaidTransactionId && (
              <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-[9px] font-medium text-success">
                reconciled
              </span>
            )}
            {locked && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                liquidated
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
            {hasChargeDelta && (
              <span title="Real card charge from Plaid (includes drink/tax)">
                charge {formatCurrency(run.amount)}
              </span>
            )}
            {run.fuelMultiplier !== null && (
              <span>
                Fuel{" "}
                {Number.isInteger(run.fuelMultiplier)
                  ? `${run.fuelMultiplier}x`
                  : `${run.fuelMultiplier.toFixed(2)}x`}
              </span>
            )}
            {run.breakdown.fuelPoints !== null && (
              <span>{formatNumber(run.breakdown.fuelPoints)} pts</span>
            )}
            {run.breakdown.mrPoints !== null && run.breakdown.mrPoints > 0 && (
              <span>{formatNumber(run.breakdown.mrPoints)} MR</span>
            )}
            {run.liquidationRate !== null && (
              <span>BBY @ {(run.liquidationRate * 100).toFixed(2)}%</span>
            )}
          </div>
        </div>
        {!editing && (
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => {
                setFace(faceValue.toFixed(2));
                {
                  const m = run.fuelMultiplier ?? 4;
                  setMult(
                    Math.abs(m - Math.round(m)) < 0.05
                      ? Math.round(m).toString()
                      : m.toFixed(2),
                  );
                }
                setRate1k(((run.fuelRatePerPoint ?? 0.0195) * 1000).toFixed(2));
                setLiqPct(((run.liquidationRate ?? 0.925) * 100).toFixed(2));
                setErr(null);
                setEditing(true);
              }}
              disabled={locked}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
              title={locked ? "Locked: assets liquidated" : "Edit run"}
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={locked || busy !== null || Boolean(run.plaidTransactionId)}
              className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
              title={
                locked
                  ? "Locked: assets liquidated"
                  : run.plaidTransactionId
                  ? "Plaid-linked. Unreconcile first."
                  : "Delete run"
              }
            >
              {busy === "delete" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
            </button>
          </div>
        )}
      </div>

      {editing && (
        <div className="mt-3 space-y-2 rounded-md border border-border/60 bg-background/40 p-2.5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="space-y-1">
              <Label className="text-[10px]">Face ($)</Label>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={face}
                onChange={(e) => setFace(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px]">Fuel mult</Label>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.5"
                value={mult}
                onChange={(e) => setMult(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px]">$/1k fuel</Label>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={rate1k}
                onChange={(e) => setRate1k(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px]">Liq %</Label>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                max="100"
                step="0.1"
                value={liqPct}
                onChange={(e) => setLiqPct(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>
          {err && <p className="text-[10px] text-destructive">{err}</p>}
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setErr(null);
              }}
              disabled={busy !== null}
            >
              <X className="h-3 w-3" /> Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={busy !== null}>
              {busy === "save" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              Save
            </Button>
          </div>
        </div>
      )}
      {err && !editing && (
        <p className="mt-1 text-[10px] text-destructive">{err}</p>
      )}
    </li>
  );
}
