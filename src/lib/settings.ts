import { prisma } from "@/lib/prisma";
import {
  MR_DEFAULT_REDEMPTION_RATE,
  MR_DEFAULT_SALE_RATE,
} from "@/lib/constants";

const MR_SALE_RATE_KEY = "mr_default_sale_rate";
const MR_REDEMPTION_RATE_KEY = "mr_default_redemption_rate";

function parseRate(value: string | null | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export async function getMrRateSettings() {
  const rows = await prisma.$queryRaw<Array<{ key: string; value: string }>>`
    SELECT key, value
    FROM AppSetting
    WHERE key IN (${MR_SALE_RATE_KEY}, ${MR_REDEMPTION_RATE_KEY})
  `;
  const byKey = new Map(rows.map((r) => [r.key, r.value] as const));
  return {
    saleRate: parseRate(byKey.get(MR_SALE_RATE_KEY), MR_DEFAULT_SALE_RATE),
    redemptionRate: parseRate(
      byKey.get(MR_REDEMPTION_RATE_KEY),
      MR_DEFAULT_REDEMPTION_RATE,
    ),
  };
}

export async function setMrRateSettings(input: {
  saleRate?: number;
  redemptionRate?: number;
}) {
  const writes: Array<Promise<unknown>> = [];
  if (input.saleRate !== undefined) {
    writes.push(
      prisma.$executeRaw`
        INSERT INTO AppSetting (key, value, createdAt, updatedAt)
        VALUES (${MR_SALE_RATE_KEY}, ${String(input.saleRate)}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updatedAt = CURRENT_TIMESTAMP
      `,
    );
  }
  if (input.redemptionRate !== undefined) {
    writes.push(
      prisma.$executeRaw`
        INSERT INTO AppSetting (key, value, createdAt, updatedAt)
        VALUES (${MR_REDEMPTION_RATE_KEY}, ${String(input.redemptionRate)}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updatedAt = CURRENT_TIMESTAMP
      `,
    );
  }
  await Promise.all(writes);
  return getMrRateSettings();
}
