import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureSubMrInventory } from "@/lib/inventory-ops";
import { ASSET_TYPE, CARD_SPECS, MR_POINT_VALUE } from "@/lib/constants";

/**
 * POST /api/cards/:id/sub-mr
 *
 * Manually mint the signup-bonus MR inventory for a card. Used when the user
 * sees the bonus posted in the Amex app but Plaid hasn't yet caught up to
 * the spend that triggered it (or the card has a non-spend bonus). Body is
 * optional — if `quantity` is provided we override Card.signupBonus first
 * so the row reflects the actual offer received.
 *
 * Idempotent: refuses to double-mint.
 */

const BodySchema = z
  .object({
    quantity: z.number().int().positive().max(10_000_000).optional(),
  })
  .optional()
  .default({});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const card = await prisma.card.findUnique({ where: { id } });
  if (!card) {
    return NextResponse.json({ error: "Card not found" }, { status: 404 });
  }

  // Force-mint path: if currentSpend hasn't crossed target yet (because Plaid
  // is behind), we still let the user record the SUB. We do this by bumping
  // currentSpend to spendTarget transiently is wrong — instead we bypass the
  // gate by calling the mint primitive ourselves here, mirroring the helper.
  const data = parsed.data ?? {};
  if (data.quantity !== undefined && data.quantity !== card.signupBonus) {
    await prisma.card.update({
      where: { id },
      data: { signupBonus: data.quantity },
    });
  }

  // First try the gated path (no-op if not crossed). If it didn't mint,
  // do an explicit mint that bypasses the spend gate.
  const auto = await ensureSubMrInventory(prisma, id);
  if (auto?.minted) {
    return NextResponse.json({ ok: true, minted: true, quantity: auto.quantity });
  }

  // Manual override: mint anyway, idempotent on existence of an "Amex SUB"
  // transaction for this card.
  const existing = await prisma.transaction.findFirst({
    where: { cardId: id, merchant: "Amex SUB" },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: "SUB already recorded for this card" },
      { status: 409 },
    );
  }
  const refreshed = await prisma.card.findUnique({ where: { id } });
  if (!refreshed) {
    return NextResponse.json({ error: "Card not found" }, { status: 404 });
  }
  const cardType = refreshed.type as keyof typeof CARD_SPECS;
  const bonus = refreshed.signupBonus > 0
    ? refreshed.signupBonus
    : (CARD_SPECS[cardType]?.signupBonusMR ?? 0);
  if (bonus <= 0) {
    return NextResponse.json(
      { error: "No SUB amount on file. Set Card.signupBonus first." },
      { status: 400 },
    );
  }
  await prisma.$transaction(async (tx) => {
    const subTxn = await tx.transaction.create({
      data: {
        cardId: id,
        date: new Date(),
        merchant: "Amex SUB",
        amount: 0,
        notes: `Manually recorded SUB: ${bonus.toLocaleString()} MR`,
        status: "RECONCILED_MS",
        reconciledAt: new Date(),
      },
    });
    await tx.inventoryAsset.create({
      data: {
        type: ASSET_TYPE.MR_POINTS,
        subType: `SUB-${refreshed.type}`,
        quantity: bonus,
        acquisitionCost: 0,
        expectedLiquidationValue: bonus * MR_POINT_VALUE,
        sourceTransactionId: subTxn.id,
      },
    });
  });
  return NextResponse.json({ ok: true, minted: true, quantity: bonus });
}
