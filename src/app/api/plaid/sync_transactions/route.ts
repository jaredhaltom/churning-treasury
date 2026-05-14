import { NextResponse } from "next/server";
import type { Transaction as PlaidTransaction, RemovedTransaction } from "plaid";
import { prisma } from "@/lib/prisma";
import { isPlaidConfigured, plaidClientForToken } from "@/lib/plaid";
import { ensureSubMrInventory } from "@/lib/inventory-ops";
import { IS_DEMO } from "@/lib/demo";

/**
 * POST /api/plaid/sync_transactions
 *
 * Pulls incremental transactions for every connected PlaidItem using
 * `/transactions/sync` (cursor-based). For each item:
 *   1. Loop until has_more = false, accumulating added/modified/removed.
 *   2. Upsert a Transaction row per Plaid txn (keyed by plaidTransactionId).
 *      New rows land as PLAID_UNRECONCILED -> they show up in the Inbox so
 *      the user can classify MS vs non-MS.
 *   3. Recompute each linked card's currentSpend from MSR-eligible rows
 *      (positive amounts, non-payment categories).
 *   4. Persist the new cursor on the PlaidItem.
 *
 * Plaid sign convention for credit accounts: amount > 0 means money OUT of
 * the account (a charge). amount < 0 is a refund/credit. We store raw amount
 * and filter sign + category when computing currentSpend.
 */

const NON_MSR_PRIMARY_CATEGORIES = new Set([
  "LOAN_PAYMENTS",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "BANK_FEES",
  "INCOME",
]);

function isPayment(txn: PlaidTransaction): boolean {
  const primary = txn.personal_finance_category?.primary;
  if (primary && NON_MSR_PRIMARY_CATEGORIES.has(primary)) return true;
  const legacy = txn.category ?? [];
  if (legacy.some((c) => /payment/i.test(c))) return true;
  return false;
}

function chooseCategory(txn: PlaidTransaction): string | null {
  return (
    txn.personal_finance_category?.detailed ??
    txn.personal_finance_category?.primary ??
    txn.category?.[0] ??
    null
  );
}

function merchantName(txn: PlaidTransaction): string {
  return txn.merchant_name ?? txn.name ?? "Unknown";
}

export async function POST() {
  if (IS_DEMO) {
    return NextResponse.json(
      { error: "Plaid integration disabled in demo mode" },
      { status: 503 },
    );
  }
  if (!isPlaidConfigured()) {
    return NextResponse.json({ error: "Plaid not configured" }, { status: 503 });
  }

  const items = await prisma.plaidItem.findMany();
  if (items.length === 0) {
    return NextResponse.json({ ok: true, items: 0, added: 0, modified: 0, removed: 0 });
  }

  let addedCount = 0;
  let modifiedCount = 0;
  let removedCount = 0;
  const touchedCardIds = new Set<string>();

  for (const item of items) {
    // Gate: if no Card is mapped to any of this Item's accounts yet, skip
    // the sync entirely. Otherwise Plaid's /transactions/sync would advance
    // the cursor past transactions we can't route to a card, losing them
    // permanently (cursor-based sync can't replay prior pages).
    const linkedCards = await prisma.card.findMany({
      where: { plaidItemId: item.id },
      select: { id: true, plaidAccountId: true },
    });
    const accountToCard = new Map<string, string>();
    for (const c of linkedCards) {
      if (c.plaidAccountId) accountToCard.set(c.plaidAccountId, c.id);
    }
    if (accountToCard.size === 0) continue;

    // Route this item's sync to the client that issued its access_token
    // (prefix-based: `access-sandbox-*` vs `access-production-*`). Without
    // this, sandbox items would hit the production host and vice versa.
    const client = plaidClientForToken(item.accessToken);

    let cursor: string | null = item.cursor;
    const added: PlaidTransaction[] = [];
    const modified: PlaidTransaction[] = [];
    const removed: RemovedTransaction[] = [];

    while (true) {
      const resp = await client.transactionsSync({
        access_token: item.accessToken,
        cursor: cursor ?? undefined,
      });
      added.push(...resp.data.added);
      modified.push(...resp.data.modified);
      removed.push(...resp.data.removed);
      cursor = resp.data.next_cursor;
      if (!resp.data.has_more) break;
    }

    for (const txn of added) {
      const cardId = accountToCard.get(txn.account_id);
      if (!cardId) continue; // Plaid account not mapped to a Card yet; ignore.
      touchedCardIds.add(cardId);

      await prisma.transaction.upsert({
        where: { plaidTransactionId: txn.transaction_id },
        create: {
          cardId,
          date: new Date(txn.date),
          merchant: merchantName(txn),
          amount: txn.amount,
          notes: null,
          // Payments / transfers don't count toward MSR and don't need a
          // human decision. Everything else lands in the Inbox.
          status: isPayment(txn) ? "IGNORED_PAYMENT" : "PLAID_UNRECONCILED",
          category: chooseCategory(txn),
          plaidTransactionId: txn.transaction_id,
          plaidAccountId: txn.account_id,
          reconciledAt: isPayment(txn) ? new Date() : null,
        },
        update: {
          amount: txn.amount,
          date: new Date(txn.date),
          merchant: merchantName(txn),
          category: chooseCategory(txn),
        },
      });
      addedCount += 1;
    }

    for (const txn of modified) {
      const cardId = accountToCard.get(txn.account_id);
      if (!cardId) continue;
      touchedCardIds.add(cardId);

      await prisma.transaction.updateMany({
        where: { plaidTransactionId: txn.transaction_id },
        data: {
          amount: txn.amount,
          date: new Date(txn.date),
          merchant: merchantName(txn),
          category: chooseCategory(txn),
        },
      });
      modifiedCount += 1;
    }

    for (const r of removed) {
      const existing = await prisma.transaction.findFirst({
        where: { plaidTransactionId: r.transaction_id },
      });
      if (existing) {
        touchedCardIds.add(existing.cardId);
        await prisma.transaction.delete({ where: { id: existing.id } });
        removedCount += 1;
      }
    }

    await prisma.plaidItem.update({
      where: { id: item.id },
      data: { cursor, lastSyncedAt: new Date() },
    });
  }

  // Recompute currentSpend for every card we touched, then auto-mint SUB
  // MR inventory for any Amex card that just crossed its threshold.
  let mintedSubs = 0;
  for (const cardId of touchedCardIds) {
    const agg = await prisma.transaction.aggregate({
      where: {
        cardId,
        plaidTransactionId: { not: null },
        status: { not: "IGNORED_PAYMENT" },
        amount: { gt: 0 },
      },
      _sum: { amount: true },
    });
    const newSpend = agg._sum.amount ?? 0;
    await prisma.card.update({
      where: { id: cardId },
      data: { currentSpend: newSpend },
    });
    const result = await ensureSubMrInventory(prisma, cardId);
    if (result?.minted) mintedSubs += 1;
  }

  return NextResponse.json({
    ok: true,
    items: items.length,
    added: addedCount,
    modified: modifiedCount,
    removed: removedCount,
    recomputedCards: touchedCardIds.size,
    mintedSubs,
  });
}
