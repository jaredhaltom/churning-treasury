import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { CARD_SPECS, CARD_TYPE } from "@/lib/constants";

const CardTypeSchema = z.enum([
  CARD_TYPE.ABP,
  CARD_TYPE.ABG,
  CARD_TYPE.VENMO,
  CARD_TYPE.OTHER,
]);

const CreateCardSchema = z.object({
  type: CardTypeSchema,
  nickname: z.string().max(64).optional().nullable(),
  openDate: z.string().datetime().optional(),
  spendTarget: z.number().nonnegative().optional(),
  cooldownDays: z.number().int().nonnegative().optional(),
  signupBonus: z.number().int().nonnegative().optional(),
});

export async function GET() {
  const cards = await prisma.card.findMany({
    orderBy: [{ closed: "asc" }, { openDate: "desc" }],
  });
  return NextResponse.json({ cards });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = CreateCardSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { type, nickname, openDate, spendTarget, cooldownDays, signupBonus } =
    parsed.data;
  const spec = CARD_SPECS[type as keyof typeof CARD_SPECS];

  const card = await prisma.card.create({
    data: {
      type,
      nickname: nickname ?? spec?.label ?? null,
      openDate: openDate ? new Date(openDate) : new Date(),
      spendTarget: spendTarget ?? spec?.spendTarget ?? 0,
      cooldownDays: cooldownDays ?? spec?.cooldownDays ?? 0,
      signupBonus: signupBonus ?? spec?.signupBonusMR ?? 0,
    },
  });

  return NextResponse.json({ card }, { status: 201 });
}
