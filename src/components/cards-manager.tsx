"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { CreditCard, Plus, Loader2, Pencil, Check, X, Sparkles, Coins } from "lucide-react";
import { CARD_SPECS, CARD_TYPE } from "@/lib/constants";
import { formatCurrency, formatNumber } from "@/lib/utils";

export interface CardRow {
  id: string;
  type: string;
  nickname: string | null;
  openDate: string; // ISO
  spendTarget: number;
  currentSpend: number;
  cooldownDays: number;
  closed: boolean;
  /** Whether this card has already had its signup-bonus MR minted into inventory. */
  subMinted: boolean;
  signupBonus: number;
}

export function CardsManager({ cards = [] }: { cards?: CardRow[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [type, setType] = React.useState<string>(CARD_TYPE.ABP);
  const [nickname, setNickname] = React.useState("");
  const [openDate, setOpenDate] = React.useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [error, setError] = React.useState<string | null>(null);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          nickname: nickname || null,
          openDate: new Date(openDate).toISOString(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to add card");
      }
      setNickname("");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-muted-foreground" />
            Cards
          </CardTitle>
          <CardDescription>
            Track MSR progress and velocity clocks per card.{" "}
            <span className="text-muted-foreground/80">
              Tip: connecting a bank via &quot;Connect bank&quot; creates cards
              for you.
            </span>
          </CardDescription>
        </div>
        <Button
          type="button"
          size="sm"
          variant={open ? "secondary" : "outline"}
          onClick={() => setOpen((v) => !v)}
        >
          <Plus className="h-3.5 w-3.5" />
          {open ? "Cancel" : "Add"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {open && (
          <form
            onSubmit={onCreate}
            className="space-y-3 rounded-lg border border-border/60 bg-secondary/30 p-3"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="new-card-type">Type</Label>
                <Select
                  id="new-card-type"
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                >
                  <option value={CARD_TYPE.ABP}>
                    {CARD_SPECS.ABP.label} (ABP)
                  </option>
                  <option value={CARD_TYPE.ABG}>
                    {CARD_SPECS.ABG.label} (ABG)
                  </option>
                  <option value={CARD_TYPE.VENMO}>
                    {CARD_SPECS.VENMO.label} (VENMO)
                  </option>
                  <option value={CARD_TYPE.OTHER}>Other</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-card-open">Open date</Label>
                <Input
                  id="new-card-open"
                  type="date"
                  value={openDate}
                  onChange={(e) => setOpenDate(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-card-nick">Nickname (optional)</Label>
              <Input
                id="new-card-nick"
                placeholder="e.g. ABG #3"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button type="submit" size="sm" disabled={submitting} className="w-full">
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding...
                </>
              ) : (
                "Add card"
              )}
            </Button>
          </form>
        )}

        {cards.length === 0 ? (
          <div className="space-y-2 rounded-md border border-dashed border-border/70 bg-secondary/20 p-3 text-xs">
            <p className="font-medium">No cards yet.</p>
            <p className="text-muted-foreground">
              Fastest path: click{" "}
              <span className="font-medium text-foreground">Connect bank</span>{" "}
              in the header. The mapping modal will let you create tracked cards
              directly from the accounts Plaid discovers. Use{" "}
              <span className="font-medium text-foreground">Add</span> here only
              for cards you <em>don&apos;t</em> want to link to Plaid.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {cards.map((c) => (
              <CardListItem key={c.id} card={c} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function CardListItem({ card }: { card: CardRow }) {
  const router = useRouter();
  const hasTarget = card.spendTarget > 0;
  const pct = hasTarget
    ? Math.min(100, Math.round((card.currentSpend / card.spendTarget) * 100))
    : 0;
  // If SUB is already recorded, treat the MSR as effectively met even when
  // Plaid lag/refunds make currentSpend look just under target.
  const hit = hasTarget && (card.currentSpend >= card.spendTarget || card.subMinted);
  const opened = new Date(card.openDate);
  const isAmex = card.type === CARD_TYPE.ABP || card.type === CARD_TYPE.ABG;

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<string>(card.currentSpend.toFixed(2));
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const [subBusy, setSubBusy] = React.useState(false);
  const [topupOpen, setTopupOpen] = React.useState(false);
  const [topupQty, setTopupQty] = React.useState("");
  const [topupBusy, setTopupBusy] = React.useState(false);
  const [actionErr, setActionErr] = React.useState<string | null>(null);

  async function recordSub() {
    setSubBusy(true);
    setActionErr(null);
    try {
      const res = await fetch(`/api/cards/${card.id}/sub-mr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed");
      }
      router.refresh();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setSubBusy(false);
    }
  }

  async function submitTopup() {
    const q = Math.floor(Number(topupQty));
    if (!Number.isFinite(q) || q <= 0) {
      setActionErr("Enter a positive integer");
      return;
    }
    setTopupBusy(true);
    setActionErr(null);
    try {
      const res = await fetch(`/api/cards/${card.id}/topup-mr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity: q }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed");
      }
      setTopupQty("");
      setTopupOpen(false);
      router.refresh();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setTopupBusy(false);
    }
  }

  function startEdit() {
    setDraft(card.currentSpend.toFixed(2));
    setErr(null);
    setEditing(true);
  }
  function cancelEdit() {
    setEditing(false);
    setErr(null);
  }
  async function saveEdit() {
    const value = Number(draft);
    if (!Number.isFinite(value) || value < 0) {
      setErr("Must be ≥ 0");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/cards/${card.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentSpend: value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to save");
      }
      setEditing(false);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="rounded-lg border border-border/60 bg-secondary/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {card.nickname ?? card.type}{" "}
            <span className="text-muted-foreground">· {card.type}</span>
          </div>
          <div className="text-[11px] text-muted-foreground">
            Opened {opened.toLocaleDateString()}
          </div>
        </div>
        {hasTarget && (
          <span
            className={
              hit
                ? "rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success"
                : "rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-warning"
            }
          >
            {hit ? "MSR met" : `${pct}%`}
          </span>
        )}
      </div>
      {hasTarget && (
        <div className="mt-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-background/80">
            <div
              className={hit ? "h-full bg-success" : "h-full bg-warning"}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[10px]">
            {editing ? (
              <div className="flex flex-1 items-center gap-1">
                <span className="text-muted-foreground">$</span>
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveEdit();
                    if (e.key === "Escape") cancelEdit();
                  }}
                  disabled={saving}
                  autoFocus
                  className="h-6 w-24 px-1.5 py-0 font-mono text-[11px]"
                />
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={saving}
                  className="rounded p-0.5 text-success hover:bg-success/10 disabled:opacity-50"
                  aria-label="Save"
                  title="Save (Enter)"
                >
                  {saving ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={saving}
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-50"
                  aria-label="Cancel"
                  title="Cancel (Esc)"
                >
                  <X className="h-3 w-3" />
                </button>
                {err && <span className="ml-1 text-destructive">{err}</span>}
              </div>
            ) : (
              <button
                type="button"
                onClick={startEdit}
                className="group flex items-center gap-1 font-mono text-muted-foreground transition-colors hover:text-foreground"
                title="Click to sync from Amex app"
              >
                <span>{formatCurrency(card.currentSpend, 0)}</span>
                <Pencil className="h-2.5 w-2.5 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            )}
            <span className="font-mono text-muted-foreground">
              {formatCurrency(card.spendTarget, 0)}
            </span>
          </div>
        </div>
      )}

      {isAmex && (
        <div className="mt-3 space-y-1.5 border-t border-border/60 pt-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {card.subMinted ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">
                <Sparkles className="h-2.5 w-2.5" />
                SUB recorded ({formatNumber(card.signupBonus)} MR)
              </span>
            ) : (
              <button
                type="button"
                onClick={recordSub}
                disabled={subBusy}
                className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-foreground transition-colors hover:bg-primary/20 disabled:opacity-50"
                title="Mark signup bonus as posted (mints MR inventory)"
              >
                {subBusy ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Sparkles className="h-2.5 w-2.5" />
                )}
                Mark SUB landed ({formatNumber(card.signupBonus || (card.type === CARD_TYPE.ABP ? CARD_SPECS.ABP.signupBonusMR : CARD_SPECS.ABG.signupBonusMR))} MR)
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setTopupOpen((v) => !v);
                setActionErr(null);
              }}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Coins className="h-2.5 w-2.5" />
              Top up MR
            </button>
          </div>
          {topupOpen && (
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                placeholder="MR earned"
                value={topupQty}
                onChange={(e) => setTopupQty(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitTopup();
                  if (e.key === "Escape") setTopupOpen(false);
                }}
                disabled={topupBusy}
                autoFocus
                className="h-7 flex-1 px-1.5 py-0 text-[11px]"
              />
              <button
                type="button"
                onClick={submitTopup}
                disabled={topupBusy}
                className="rounded p-0.5 text-success hover:bg-success/10 disabled:opacity-50"
                title="Add (Enter)"
              >
                {topupBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
              </button>
              <button
                type="button"
                onClick={() => setTopupOpen(false)}
                disabled={topupBusy}
                className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-50"
                title="Cancel (Esc)"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          {actionErr && (
            <p className="text-[10px] text-destructive">{actionErr}</p>
          )}
        </div>
      )}
    </li>
  );
}
