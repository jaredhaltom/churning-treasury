"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ShoppingCart, Loader2 } from "lucide-react";
import {
  BBY_LIQUIDATION_RATE_MID,
  BBY_LIQUIDATION_RATE_PRESETS,
  CARD_TYPE,
  FUEL_POINT_VALUE_MID,
  KINGSOOPERS_DEFAULT_FUEL_MULTIPLIER,
  KINGSOOPERS_EARN_RULES,
  MR_POINT_VALUE,
  type CardType,
} from "@/lib/constants";
import { cn, formatCurrency, formatNumber } from "@/lib/utils";

const FUEL_MULTIPLIER_PRESETS = [2, 4] as const;
const DEFAULT_LIQUIDATION_PCT = Math.round(BBY_LIQUIDATION_RATE_MID * 1000) / 10;

export interface CardOption {
  id: string;
  type: string;
  nickname: string | null;
}

export function KingSoopersForm({ cards = [] }: { cards?: CardOption[] }) {
  const router = useRouter();
  const [cardId, setCardId] = React.useState<string>(cards[0]?.id ?? "");
  const [faceValue, setFaceValue] = React.useState<string>("");
  // Users read fuel rates as "$19.50 per 1000 points" in the wild, so the
  // input is denominated that way. We convert to per-point at submit time.
  const [fuelRatePer1k, setFuelRatePer1k] = React.useState<string>(
    (FUEL_POINT_VALUE_MID * 1000).toFixed(2),
  );
  const [fuelMultiplier, setFuelMultiplier] = React.useState<number>(
    KINGSOOPERS_DEFAULT_FUEL_MULTIPLIER,
  );
  const [liquidationPct, setLiquidationPct] = React.useState<number>(
    DEFAULT_LIQUIDATION_PCT,
  );
  const [notes, setNotes] = React.useState<string>("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!cardId && cards.length > 0) setCardId(cards[0].id);
  }, [cards, cardId]);

  const face = Number(faceValue) || 0;
  const fuelPerPoint = (Number(fuelRatePer1k) || 0) / 1000;
  const liqRate = liquidationPct / 100;

  const selectedCard = cards.find((c) => c.id === cardId);
  const cardType: CardType =
    selectedCard && (selectedCard.type in KINGSOOPERS_EARN_RULES)
      ? (selectedCard.type as CardType)
      : CARD_TYPE.OTHER;
  const rules = KINGSOOPERS_EARN_RULES[cardType];

  const fuelPoints = face * fuelMultiplier;
  const cashback = face * rules.cashbackRate;
  const mrPoints = face * rules.mrPerDollar;

  const expectedGC = face * liqRate;
  const expectedFuel = fuelPoints * fuelPerPoint;
  const expectedMR = mrPoints * MR_POINT_VALUE;
  const totalExpected = expectedGC + expectedFuel + cashback + expectedMR;
  const netProfit = totalExpected - face;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (face <= 0) {
      setError("Enter a gift card face value greater than zero.");
      return;
    }
    if (!cardId) {
      setError("Select a card first (add one in the Cards panel).");
      return;
    }
    if (fuelPerPoint <= 0) {
      setError("Fuel rate must be greater than zero.");
      return;
    }
    if (fuelMultiplier <= 0) {
      setError("Fuel multiplier must be greater than zero.");
      return;
    }
    if (liquidationPct <= 0 || liquidationPct > 100) {
      setError("Liquidation rate must be between 0 and 100%.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/king-soopers-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          faceValue: face,
          cardId,
          fuelRate: fuelPerPoint,
          fuelMultiplier,
          liquidationRate: liqRate,
          notes,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to log run.");
      }
      setFaceValue("");
      setNotes("");
      setSuccess(`Logged ${formatCurrency(face)} BBY on ${cardLabel(selectedCard)}.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShoppingCart className="h-4 w-4 text-muted-foreground" />
          Log a King Soopers Run
        </CardTitle>
        <CardDescription>
          Log only the gift card portion. Card charges reconcile via Plaid / Inbox.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="card">Card used</Label>
              {cards.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                  No cards on file. Add one in the Cards panel.
                </p>
              ) : (
                <Select
                  id="card"
                  value={cardId}
                  onChange={(e) => setCardId(e.target.value)}
                  disabled={cards.length === 0}
                >
                  {cards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {cardLabel(c)}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="face">Gift card face value ($)</Label>
              <Input
                id="face"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="500.00"
                value={faceValue}
                onChange={(e) => setFaceValue(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="fuel">Fuel rate ($ per 1,000 pts)</Label>
              <Input
                id="fuel"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={fuelRatePer1k}
                onChange={(e) => setFuelRatePer1k(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Fuel multiplier</Label>
              <div className="flex items-center gap-2">
                {FUEL_MULTIPLIER_PRESETS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setFuelMultiplier(m)}
                    className={cn(
                      "h-10 flex-1 rounded-md border text-sm font-medium transition-colors",
                      fuelMultiplier === m
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    {m}x
                  </button>
                ))}
                <Input
                  aria-label="Custom fuel multiplier"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.5"
                  value={fuelMultiplier}
                  onChange={(e) => setFuelMultiplier(Number(e.target.value) || 0)}
                  className="w-20"
                />
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>BBY liquidation rate (%)</Label>
            <div className="flex items-center gap-2">
              {BBY_LIQUIDATION_RATE_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setLiquidationPct(p)}
                  className={cn(
                    "h-10 flex-1 rounded-md border text-sm font-medium transition-colors",
                    liquidationPct === p
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  {p}%
                </button>
              ))}
              <Input
                aria-label="Custom liquidation rate (%)"
                type="number"
                inputMode="decimal"
                min="0"
                max="100"
                step="0.1"
                value={liquidationPct}
                onChange={(e) => setLiquidationPct(Number(e.target.value) || 0)}
                className="w-24"
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              Typical buyer range 91-94%. This is the <em>expected</em> rate —
              the realized rate gets recorded when you actually liquidate.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Input
              id="notes"
              placeholder="Store #, denominations, etc."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="rounded-lg border border-border/60 bg-secondary/30 p-4 text-sm">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              Resulting inventory
            </div>
            <div className="grid grid-cols-2 gap-2 font-mono text-xs sm:grid-cols-4">
              <Breakdown
                label="BBY GC"
                primary={formatCurrency(face)}
                secondary={`~${formatCurrency(expectedGC)} @ ${liquidationPct}%`}
              />
              <Breakdown
                label={`Fuel Pts (${fuelMultiplier}x)`}
                primary={formatNumber(fuelPoints)}
                secondary={`~${formatCurrency(expectedFuel)}`}
              />
              {rules.cashbackRate > 0 && (
                <Breakdown
                  label="Cashback"
                  primary={formatCurrency(cashback)}
                  secondary="already liquid"
                />
              )}
              {rules.mrPerDollar > 0 && (
                <Breakdown
                  label="MR Pts"
                  primary={formatNumber(mrPoints)}
                  secondary={`~${formatCurrency(expectedMR)} @ 1.3cpp`}
                />
              )}
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-3 text-xs">
              <span className="text-muted-foreground">Expected net profit</span>
              <span
                className={
                  netProfit >= 0
                    ? "font-mono font-semibold text-success"
                    : "font-mono font-semibold text-destructive"
                }
              >
                {formatCurrency(netProfit)}
                <span className="ml-1 text-muted-foreground">
                  ({face > 0 ? ((netProfit / face) * 100).toFixed(2) : "0.00"}%)
                </span>
              </span>
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {success && (
            <p className="text-sm text-success" role="status">
              {success}
            </p>
          )}

          <Button
            type="submit"
            disabled={submitting || face <= 0 || !cardId}
            className="w-full"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Logging...
              </>
            ) : (
              "Log run"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Breakdown({
  label,
  primary,
  secondary,
}: {
  label: string;
  primary: string;
  secondary: string;
}) {
  return (
    <div className="rounded-md bg-background/60 p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-sm">{primary}</div>
      <div className="text-[10px] text-muted-foreground">{secondary}</div>
    </div>
  );
}

function cardLabel(c: CardOption | undefined) {
  if (!c) return "";
  return c.nickname ? `${c.nickname} (${c.type})` : c.type;
}
