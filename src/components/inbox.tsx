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
import { Inbox as InboxIcon, Loader2, CheckCircle2, XCircle, ShoppingCart, Link as LinkIcon } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import {
  BBY_LIQUIDATION_RATE_MID,
  FUEL_POINT_VALUE_MID,
  KINGSOOPERS_DEFAULT_FUEL_MULTIPLIER,
} from "@/lib/constants";

export interface InboxRow {
  id: string;
  date: string; // ISO
  merchant: string;
  amount: number;
  category: string | null;
  cardId: string;
  cardLabel: string;
  /** Likely-MS signal: amount >= $500 at Kroger/King Soopers */
  likelyMS: boolean;
  /** Manual entries on the same card with no Plaid link yet */
  candidateManualMatches: Array<{
    id: string;
    date: string;
    amount: number;
    merchant: string;
  }>;
}

export function Inbox({ rows = [] }: { rows?: InboxRow[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <InboxIcon className="h-4 w-4 text-muted-foreground" />
            Inbox
          </CardTitle>
          <CardDescription>No unreconciled charges. Clean slate.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <InboxIcon className="h-4 w-4 text-muted-foreground" />
          Inbox
          <span className="ml-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-warning">
            {rows.length}
          </span>
        </CardTitle>
        <CardDescription>
          Plaid-synced charges waiting for you to classify.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {rows.map((r) => (
            <InboxItem key={r.id} row={r} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

type Mode = "idle" | "logging" | "linking";

function InboxItem({ row }: { row: InboxRow }) {
  const router = useRouter();
  const [mode, setMode] = React.useState<Mode>("idle");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  // "Log new MS" sub-form state
  const [faceValue, setFaceValue] = React.useState<string>(row.amount.toFixed(2));
  const [fuelMultiplier, setFuelMultiplier] = React.useState<number>(
    KINGSOOPERS_DEFAULT_FUEL_MULTIPLIER,
  );
  const [fuelRatePer1k, setFuelRatePer1k] = React.useState<string>(
    (FUEL_POINT_VALUE_MID * 1000).toFixed(2),
  );
  const [liquidationPct, setLiquidationPct] = React.useState<number>(
    Math.round(BBY_LIQUIDATION_RATE_MID * 1000) / 10,
  );

  // "Link manual" state
  const [selectedManual, setSelectedManual] = React.useState<string>("");

  async function act(body: object, busyKey: string) {
    setBusy(busyKey);
    setErr(null);
    try {
      const res = await fetch("/api/transactions/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId: row.id, ...body }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed");
      }
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="rounded-lg border border-border/60 bg-secondary/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{row.merchant}</span>
            {row.likelyMS && (
              <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                likely MS
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>{new Date(row.date).toLocaleDateString()}</span>
            <span>·</span>
            <span>{row.cardLabel}</span>
            {row.category && (
              <>
                <span>·</span>
                <span className="truncate">{row.category}</span>
              </>
            )}
          </div>
        </div>
        <div className="font-mono text-sm tabular-nums">
          {formatCurrency(row.amount)}
        </div>
      </div>

      {mode === "idle" && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setMode("logging")}
          >
            <ShoppingCart className="h-3 w-3" /> Log as MS run
          </Button>
          {row.candidateManualMatches.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setMode("linking")}
            >
              <LinkIcon className="h-3 w-3" /> Link to manual entry
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => act({ action: "mark_non_ms" }, "mark_non_ms")}
            disabled={busy !== null}
          >
            {busy === "mark_non_ms" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3 w-3" />
            )}
            Not MS
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => act({ action: "ignore" }, "ignore")}
            disabled={busy !== null}
          >
            {busy === "ignore" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <XCircle className="h-3 w-3" />
            )}
            Ignore
          </Button>
        </div>
      )}

      {mode === "logging" && (
        <div className="mt-2 space-y-2 rounded-md border border-border/60 bg-background/40 p-2.5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="space-y-1">
              <Label className="text-[10px]">GC face value ($)</Label>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={faceValue}
                onChange={(e) => setFaceValue(e.target.value)}
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
                value={fuelMultiplier}
                onChange={(e) => setFuelMultiplier(Number(e.target.value) || 0)}
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
                value={fuelRatePer1k}
                onChange={(e) => setFuelRatePer1k(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px]">Liq rate (%)</Label>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                max="100"
                step="0.1"
                value={liquidationPct}
                onChange={(e) => setLiquidationPct(Number(e.target.value) || 0)}
                className="h-8 text-xs"
              />
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Plaid says {formatCurrency(row.amount)} charged; face value may be
            less if you grabbed a drink.
          </p>
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode("idle")}
              disabled={busy !== null}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const face = Number(faceValue);
                const rate = Number(fuelRatePer1k) / 1000;
                act(
                  {
                    action: "log_new_ms",
                    faceValue: face,
                    fuelMultiplier,
                    fuelRate: rate,
                    liquidationRate: liquidationPct / 100,
                  },
                  "log_new_ms",
                );
              }}
              disabled={busy !== null || Number(faceValue) <= 0}
            >
              {busy === "log_new_ms" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : null}
              Confirm MS
            </Button>
          </div>
        </div>
      )}

      {mode === "linking" && (
        <div className="mt-2 space-y-2 rounded-md border border-border/60 bg-background/40 p-2.5">
          <Label className="text-[10px]">Pick the manual entry this matches</Label>
          <div className="space-y-1">
            {row.candidateManualMatches.map((m) => (
              <label
                key={m.id}
                className="flex cursor-pointer items-center justify-between gap-2 rounded border border-border/60 px-2 py-1.5 text-xs hover:bg-accent"
              >
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`manual-${row.id}`}
                    value={m.id}
                    checked={selectedManual === m.id}
                    onChange={() => setSelectedManual(m.id)}
                  />
                  <span>
                    {new Date(m.date).toLocaleDateString()} · {m.merchant}
                  </span>
                </div>
                <span className="font-mono">{formatCurrency(m.amount)}</span>
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode("idle")}
              disabled={busy !== null}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() =>
                act(
                  { action: "link_manual", manualTransactionId: selectedManual },
                  "link_manual",
                )
              }
              disabled={busy !== null || !selectedManual}
            >
              {busy === "link_manual" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : null}
              Link
            </Button>
          </div>
        </div>
      )}

      {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
    </li>
  );
}
