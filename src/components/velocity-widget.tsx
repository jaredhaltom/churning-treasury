import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { CARD_SPECS, CARD_TYPE, daysUntilEligible, type CardType } from "@/lib/constants";
import { Clock3, CheckCircle2 } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";

async function getMostRecentCard(cardType: CardType) {
  return prisma.card.findFirst({
    where: { type: cardType },
    orderBy: { openDate: "desc" },
    select: {
      openDate: true,
      nickname: true,
      spendTarget: true,
      currentSpend: true,
    },
  });
}

function VelocityRow({
  label,
  spendTarget,
  bonus,
  lastOpenDate,
  currentSpend,
  cardSpendTarget,
  cooldown,
}: {
  label: string;
  spendTarget: number;
  bonus: number;
  lastOpenDate: Date | null;
  currentSpend: number | null;
  cardSpendTarget: number | null;
  cooldown: number;
}) {
  const remaining = daysUntilEligible(lastOpenDate, cooldown);
  const eligible = remaining === 0;
  const progressPct = lastOpenDate
    ? Math.min(100, Math.round(((cooldown - remaining) / cooldown) * 100))
    : 100;

  const target = cardSpendTarget && cardSpendTarget > 0 ? cardSpendTarget : spendTarget;
  const spend = currentSpend ?? 0;
  const msrPct = target > 0 ? Math.min(100, Math.round((spend / target) * 100)) : 0;
  const msrHit = target > 0 && spend >= target;

  return (
    <div className="rounded-lg border border-border/60 bg-secondary/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{label}</div>
          <div className="text-xs text-muted-foreground">
            ${spendTarget.toLocaleString()} spend &middot; {bonus.toLocaleString()} MR
          </div>
        </div>
        <div
          className={cn(
            "flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium",
            eligible
              ? "bg-success/15 text-success"
              : "bg-warning/15 text-warning",
          )}
        >
          {eligible ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clock3 className="h-3.5 w-3.5" />}
          {eligible ? "Eligible now" : `${remaining}d remaining`}
        </div>
      </div>

      {/* Cooldown bar */}
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background/80">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            eligible ? "bg-success" : "bg-warning",
          )}
          style={{ width: `${progressPct}%` }}
        />
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>
          {lastOpenDate
            ? `Last opened ${lastOpenDate.toLocaleDateString()}`
            : "No cards on file"}
        </span>
        <span>{cooldown}d cooldown</span>
      </div>

      {/* MSR progress on the most recent card of this type */}
      {lastOpenDate && target > 0 && (
        <div className="mt-3 border-t border-border/60 pt-3">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">Current card MSR</span>
            <span
              className={cn(
                "font-mono",
                msrHit ? "text-success" : "text-muted-foreground",
              )}
            >
              {formatCurrency(spend, 0)} / {formatCurrency(target, 0)}
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-background/80">
            <div
              className={msrHit ? "h-full bg-success" : "h-full bg-primary/60"}
              style={{ width: `${msrPct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export async function VelocityWidget() {
  const [abp, abg] = await Promise.all([
    getMostRecentCard(CARD_TYPE.ABP),
    getMostRecentCard(CARD_TYPE.ABG),
  ]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock3 className="h-4 w-4 text-muted-foreground" />
          Velocity Clocks
        </CardTitle>
        <CardDescription>91-day Amex family cooldown &middot; MSR progress</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <VelocityRow
          label={CARD_SPECS.ABP.label}
          spendTarget={CARD_SPECS.ABP.spendTarget}
          bonus={CARD_SPECS.ABP.signupBonusMR}
          lastOpenDate={abp?.openDate ?? null}
          currentSpend={abp?.currentSpend ?? null}
          cardSpendTarget={abp?.spendTarget ?? null}
          cooldown={CARD_SPECS.ABP.cooldownDays}
        />
        <VelocityRow
          label={CARD_SPECS.ABG.label}
          spendTarget={CARD_SPECS.ABG.spendTarget}
          bonus={CARD_SPECS.ABG.signupBonusMR}
          lastOpenDate={abg?.openDate ?? null}
          currentSpend={abg?.currentSpend ?? null}
          cardSpendTarget={abg?.spendTarget ?? null}
          cooldown={CARD_SPECS.ABG.cooldownDays}
        />
      </CardContent>
    </Card>
  );
}
