import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { CARD_SPECS, CARD_TYPE, type CardType } from "@/lib/constants";
import { IS_DEMO } from "@/lib/demo";

/**
 * POST /api/plaid/link_card
 *
 * Binds a Plaid account_id (inside a PlaidItem) to a Card. Supports two modes:
 *
 *   1. Bind to an existing Card   — pass { cardId }
 *   2. Create + bind a brand-new Card from this Plaid account
 *                                 — pass { newCard: { type, nickname?, openDate } }
 *
 * Mode 2 is the "Plaid-first" setup flow: you connect a bank and the mapping
 * modal just asks "what kind of card is this?" + "when did you open it?".
 * Spend target / cooldown are pulled from CARD_SPECS based on type.
 *
 * After this call, currentSpend becomes Plaid-derived for the card (the Card
 * PATCH route rejects manual writes to currentSpend when plaidItemId is set).
 */

const NewCardSchema = z.object({
  type: z.enum([CARD_TYPE.ABP, CARD_TYPE.ABG, CARD_TYPE.VENMO, CARD_TYPE.OTHER]),
  nickname: z.string().min(1).max(80).optional(),
  /** ISO 8601 date (YYYY-MM-DD or full). Defaults to today if omitted. */
  openDate: z.string().optional(),
  /** Optional override; otherwise pulled from CARD_SPECS. */
  spendTarget: z.number().nonnegative().optional(),
});

const BodySchema = z
  .object({
    plaidItemId: z.string().min(1),
    plaidAccountId: z.string().min(1),
    cardId: z.string().min(1).optional(),
    newCard: NewCardSchema.optional(),
  })
  .refine((d) => Boolean(d.cardId) !== Boolean(d.newCard), {
    message: "Provide exactly one of { cardId } or { newCard }.",
  });

function specsFor(type: CardType) {
  return type === CARD_TYPE.OTHER
    ? { spendTarget: 0, cooldownDays: 0 }
    : CARD_SPECS[type];
}

export async function POST(req: NextRequest) {
  if (IS_DEMO) {
    return NextResponse.json(
      { error: "Plaid integration disabled in demo mode" },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { plaidItemId, plaidAccountId, cardId, newCard } = parsed.data;

  const item = await prisma.plaidItem.findUnique({ where: { id: plaidItemId } });
  if (!item) {
    return NextResponse.json({ error: "Plaid item not found" }, { status: 404 });
  }

  const conflict = await prisma.card.findFirst({
    where: {
      plaidAccountId,
      ...(cardId ? { NOT: { id: cardId } } : {}),
    },
  });
  if (conflict) {
    return NextResponse.json(
      {
        error: `That Plaid account is already linked to "${conflict.nickname ?? conflict.type}".`,
      },
      { status: 409 },
    );
  }

  if (cardId) {
    const updated = await prisma.card.update({
      where: { id: cardId },
      data: { plaidItemId, plaidAccountId },
    });
    return NextResponse.json({ card: updated, created: false });
  }

  // Create + bind
  const spec = specsFor(newCard!.type);
  const openDate = newCard!.openDate ? new Date(newCard!.openDate) : new Date();
  if (Number.isNaN(openDate.getTime())) {
    return NextResponse.json(
      { error: "Invalid openDate" },
      { status: 400 },
    );
  }

  const created = await prisma.card.create({
    data: {
      type: newCard!.type,
      nickname: newCard!.nickname ?? null,
      openDate,
      spendTarget: newCard!.spendTarget ?? spec.spendTarget,
      cooldownDays: spec.cooldownDays,
      plaidItemId,
      plaidAccountId,
    },
  });
  return NextResponse.json({ card: created, created: true }, { status: 201 });
}
