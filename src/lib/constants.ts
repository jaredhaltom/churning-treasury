// Central place for every business rule. Tweak these and the rest of the
// application reacts. Do NOT hardcode any of these values elsewhere.

export const CARD_TYPE = {
  ABP: "ABP",
  ABG: "ABG",
  VENMO: "VENMO",
  OTHER: "OTHER",
} as const;
export type CardType = (typeof CARD_TYPE)[keyof typeof CARD_TYPE];

export const ASSET_TYPE = {
  GIFT_CARD: "GIFT_CARD",
  FUEL_POINTS: "FUEL_POINTS",
  MR_POINTS: "MR_POINTS",
  CASHBACK: "CASHBACK",
} as const;
export type AssetType = (typeof ASSET_TYPE)[keyof typeof ASSET_TYPE];

export const ASSET_STATUS = {
  HELD: "HELD",
  PENDING_SALE: "PENDING_SALE",
  LIQUIDATED: "LIQUIDATED",
} as const;
export type AssetStatus = (typeof ASSET_STATUS)[keyof typeof ASSET_STATUS];

export const PROCEEDS_TYPE = {
  CASH: "CASH",
  NON_CASH: "NON_CASH",
} as const;
export type ProceedsType = (typeof PROCEEDS_TYPE)[keyof typeof PROCEEDS_TYPE];

// --- Velocity rules ---------------------------------------------------------
export const AMEX_COOLDOWN_DAYS = 91;

export const CARD_SPECS = {
  [CARD_TYPE.ABP]: {
    label: "Amex Business Platinum",
    spendTarget: 20_000,
    signupBonusMR: 300_000,
    cooldownDays: AMEX_COOLDOWN_DAYS,
  },
  [CARD_TYPE.ABG]: {
    label: "Amex Business Gold",
    spendTarget: 15_000,
    signupBonusMR: 200_000,
    cooldownDays: AMEX_COOLDOWN_DAYS,
  },
  [CARD_TYPE.VENMO]: {
    label: "Venmo Credit Card",
    spendTarget: 0,
    signupBonusMR: 0,
    cooldownDays: 0,
  },
} as const;

// --- Multipliers / earn rates ----------------------------------------------
export const VENMO_GROCERY_CASHBACK_RATE = 0.09;           // 9% cashback
// Default fuel-point multiplier on GC purchases at King Soopers. Kroger runs
// promos (2x / 3x / 4x / 5x) throughout the year, so this is overridable
// per-run in the form / API. 4x is the common "gift card special" promo.
export const KINGSOOPERS_DEFAULT_FUEL_MULTIPLIER = 4;
/** @deprecated Use KINGSOOPERS_DEFAULT_FUEL_MULTIPLIER. Alias kept for back-compat. */
export const KINGSOOPERS_FUEL_POINTS_PER_DOLLAR = KINGSOOPERS_DEFAULT_FUEL_MULTIPLIER;

// --- Liquidation rates ------------------------------------------------------
// BBY gift cards: typical payout range 91-94% of face. The exact rate is
// buyer- and load-specific, so every run gets its own rate — these constants
// just seed the UI defaults.
export const BBY_LIQUIDATION_RATE_LOW = 0.91;
export const BBY_LIQUIDATION_RATE_HIGH = 0.94;
export const BBY_LIQUIDATION_RATE_MID =
  (BBY_LIQUIDATION_RATE_LOW + BBY_LIQUIDATION_RATE_HIGH) / 2; // 0.925
/** Typical preset buttons for the form (percents). */
export const BBY_LIQUIDATION_RATE_PRESETS = [91, 92, 93, 94] as const;

// Fuel points: $19-$20 per 1000. Midpoint $19.50 per 1000 = $0.0195 / point.
export const FUEL_POINT_VALUE_LOW = 19 / 1000;
export const FUEL_POINT_VALUE_HIGH = 20 / 1000;
export const FUEL_POINT_VALUE_MID =
  (FUEL_POINT_VALUE_LOW + FUEL_POINT_VALUE_HIGH) / 2; // 0.0195

// MR points: 1.3 cpp.
export const MR_POINT_VALUE = 0.013;
export const MR_DEFAULT_SALE_RATE = 0.013; // 1.3 cpp
export const MR_DEFAULT_REDEMPTION_RATE = 0.01; // 1.0 cpp

// --- Per-card earn rules at King Soopers -----------------------------------
// Fuel points (4x) are Kroger's, independent of card. MR / cashback ARE card-
// specific. `contributesToMSR` drives whether we bump Card.currentSpend.
export interface KingSoopersEarnRule {
  mrPerDollar: number;     // MR points per $1 spent on this card at KS
  cashbackRate: number;    // e.g. 0.09 for 9%
  contributesToMSR: boolean;
}

export const KINGSOOPERS_EARN_RULES: Record<CardType, KingSoopersEarnRule> = {
  [CARD_TYPE.ABP]: { mrPerDollar: 1, cashbackRate: 0, contributesToMSR: true },
  [CARD_TYPE.ABG]: { mrPerDollar: 4, cashbackRate: 0, contributesToMSR: true },
  [CARD_TYPE.VENMO]: {
    mrPerDollar: 0,
    cashbackRate: VENMO_GROCERY_CASHBACK_RATE,
    contributesToMSR: false,
  },
  [CARD_TYPE.OTHER]: { mrPerDollar: 0, cashbackRate: 0, contributesToMSR: false },
};

// --- Accounting helpers -----------------------------------------------------

export interface SplitKingSoopersRunInput {
  dollars: number;
  cardType: CardType;
  /** $ per fuel point. Defaults to FUEL_POINT_VALUE_MID ($0.0195). Editable per-run. */
  fuelRate?: number;
  /** Kroger fuel-point multiplier on GC purchase (2x, 4x, etc.). Defaults to 4. */
  fuelMultiplier?: number;
  /**
   * Expected BBY liquidation rate for this specific run as a decimal
   * (0.91..0.94). Drives `expectedLiquidationValue` on the GC asset. The
   * eventual LiquidationEvent can record a different realized rate.
   */
  liquidationRate?: number;
}

export interface InventoryAssetSeed {
  type: AssetType;
  subType: string;
  quantity: number;
  acquisitionCost: number;
  expectedLiquidationValue: number;
}

export interface KingSoopersSplit {
  giftCard: InventoryAssetSeed;
  fuelPoints: InventoryAssetSeed;
  cashback?: InventoryAssetSeed;
  mrPoints?: InventoryAssetSeed;
}

/**
 * Split a King Soopers run into the resulting InventoryAsset rows.
 * Cost-basis rule: the gift card carries the full cash outlay; every other
 * asset (fuel, cashback, MR) has cost = 0 because they're bonuses earned
 * on the spend. Keeps working-capital math honest.
 */
export function splitKingSoopersRun({
  dollars,
  cardType,
  fuelRate = FUEL_POINT_VALUE_MID,
  fuelMultiplier = KINGSOOPERS_DEFAULT_FUEL_MULTIPLIER,
  liquidationRate = BBY_LIQUIDATION_RATE_MID,
}: SplitKingSoopersRunInput): KingSoopersSplit {
  const rules = KINGSOOPERS_EARN_RULES[cardType];
  const giftCardFace = dollars;
  const fuelPoints = dollars * fuelMultiplier;

  // Encode the per-run liquidation rate in subType so inventory rows are
  // self-describing in reports — "BBY-92%" vs "BBY-94%" etc.
  // Keep two decimals of precision so 93.75% doesn't round to 93.8%; trim
  // trailing zeros for clean integer/half-percent labels.
  const ratePct = Math.round(liquidationRate * 10000) / 100; // 0.9375 -> 93.75
  const bbySubType = `BBY-${
    Number.isInteger(ratePct)
      ? ratePct
      : Number(ratePct.toFixed(2)).toString()
  }%`;

  const split: KingSoopersSplit = {
    giftCard: {
      type: ASSET_TYPE.GIFT_CARD,
      subType: bbySubType,
      quantity: giftCardFace,
      acquisitionCost: giftCardFace,
      expectedLiquidationValue: giftCardFace * liquidationRate,
    },
    fuelPoints: {
      // Encode the promo multiplier in subType so historical rows self-describe
      // (e.g. "KS-4x"). Useful later for analyzing profit delta between promos.
      type: ASSET_TYPE.FUEL_POINTS,
      subType: `KS-${fuelMultiplier}x`,
      quantity: fuelPoints,
      acquisitionCost: 0,
      expectedLiquidationValue: fuelPoints * fuelRate,
    },
  };

  if (rules.cashbackRate > 0) {
    const cashback = dollars * rules.cashbackRate;
    split.cashback = {
      type: ASSET_TYPE.CASHBACK,
      subType: cardType,
      quantity: cashback,
      acquisitionCost: 0,
      expectedLiquidationValue: cashback,
    };
  }

  if (rules.mrPerDollar > 0) {
    const mr = dollars * rules.mrPerDollar;
    split.mrPoints = {
      type: ASSET_TYPE.MR_POINTS,
      subType: cardType,
      quantity: mr,
      acquisitionCost: 0,
      expectedLiquidationValue: mr * MR_POINT_VALUE,
    };
  }

  return split;
}

/** True if a card of this type counts toward its own MSR when used at KS. */
export function cardContributesToMSR(cardType: CardType): boolean {
  return KINGSOOPERS_EARN_RULES[cardType]?.contributesToMSR ?? false;
}

/** Days until a new card of this type can be opened. 0 means eligible now. */
export function daysUntilEligible(
  lastOpenDate: Date | null,
  cooldown = AMEX_COOLDOWN_DAYS,
  now: Date = new Date(),
): number {
  if (!lastOpenDate) return 0;
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  const elapsed = Math.floor((now.getTime() - lastOpenDate.getTime()) / MS_PER_DAY);
  return Math.max(0, cooldown - elapsed);
}
