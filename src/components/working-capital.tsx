import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { ASSET_STATUS, ASSET_TYPE } from "@/lib/constants";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { Banknote, TrendingUp, Hourglass } from "lucide-react";

export async function WorkingCapital() {
  // Gift cards still on the books = cash currently tied up.
  const bbyAggregates = await prisma.inventoryAsset.aggregate({
    _sum: { acquisitionCost: true, expectedLiquidationValue: true, quantity: true },
    _count: true,
    where: {
      type: ASSET_TYPE.GIFT_CARD,
      subType: "BBY",
      status: { not: ASSET_STATUS.LIQUIDATED },
    },
  });

  // Oldest still-held gift card = days of capital at risk.
  const oldestHeld = await prisma.inventoryAsset.findFirst({
    where: {
      type: ASSET_TYPE.GIFT_CARD,
      status: { not: ASSET_STATUS.LIQUIDATED },
    },
    orderBy: { acquiredDate: "asc" },
    select: { acquiredDate: true },
  });

  const capitalDeployed = bbyAggregates._sum.acquisitionCost ?? 0;
  const expectedReturn = bbyAggregates._sum.expectedLiquidationValue ?? 0;
  const faceValue = bbyAggregates._sum.quantity ?? 0;
  const cardCount = bbyAggregates._count;
  const expectedLoss = capitalDeployed - expectedReturn;

  const ageDays = oldestHeld
    ? Math.floor(
        (Date.now() - new Date(oldestHeld.acquiredDate).getTime()) / (1000 * 60 * 60 * 24),
      )
    : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Banknote className="h-4 w-4 text-muted-foreground" />
          Working Capital
        </CardTitle>
        <CardDescription>
          Cash tied up in unliquidated BBY gift cards
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-4xl font-semibold tracking-tight font-mono">
          {formatCurrency(capitalDeployed)}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          across {cardCount} card{cardCount === 1 ? "" : "s"} &middot; face{" "}
          {formatCurrency(faceValue, 0)}
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-border/60 bg-secondary/30 p-3">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <TrendingUp className="h-3 w-3" /> Expected liquidation
            </div>
            <div className="mt-1 font-mono text-lg">
              {formatCurrency(expectedReturn)}
            </div>
            <div className="text-xs text-muted-foreground">
              Loss at midpoint: {formatCurrency(expectedLoss)}
            </div>
          </div>
          <div className="rounded-lg border border-border/60 bg-secondary/30 p-3">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <Hourglass className="h-3 w-3" /> Oldest position
            </div>
            <div className="mt-1 font-mono text-lg">{formatNumber(ageDays)}d</div>
            <div className="text-xs text-muted-foreground">Days outstanding</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
