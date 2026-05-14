import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isPlaidConfigured, plaidClient } from "@/lib/plaid";
import { IS_DEMO } from "@/lib/demo";

/**
 * GET /api/plaid/items
 *
 * Returns every PlaidItem and its current accounts (fetched live from Plaid),
 * with which Card (if any) is currently bound to each account. The dashboard
 * uses this to render a "Finish mapping" control for any Item that has
 * un-bound accounts, recovering from the case where the post-Link mapping
 * modal was closed without saving.
 */
export async function GET() {
  if (IS_DEMO) {
    return NextResponse.json(
      { error: "Plaid integration disabled in demo mode" },
      { status: 503 },
    );
  }
  if (!isPlaidConfigured()) {
    return NextResponse.json({ items: [] });
  }

  const items = await prisma.plaidItem.findMany({
    include: { cards: true },
    orderBy: { createdAt: "asc" },
  });

  const results = await Promise.all(
    items.map(async (item) => {
      try {
        const resp = await plaidClient.accountsGet({
          access_token: item.accessToken,
        });
        const accounts = resp.data.accounts.map((a) => {
          const linkedCard = item.cards.find((c) => c.plaidAccountId === a.account_id);
          return {
            accountId: a.account_id,
            name: a.name,
            officialName: a.official_name,
            mask: a.mask,
            subtype: a.subtype,
            type: a.type,
            linkedCardId: linkedCard?.id ?? null,
            linkedCardLabel: linkedCard
              ? linkedCard.nickname ?? linkedCard.type
              : null,
          };
        });
        return {
          id: item.id,
          institutionName: item.institutionName,
          lastSyncedAt: item.lastSyncedAt,
          accounts,
        };
      } catch {
        return {
          id: item.id,
          institutionName: item.institutionName,
          lastSyncedAt: item.lastSyncedAt,
          accounts: [],
          error: "Failed to fetch accounts",
        };
      }
    }),
  );

  return NextResponse.json({ items: results });
}
