import { getLosslessJsonNumberToken } from "./lossless-json.js";

export const PRICE_DECIMAL_V1 = /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,6})?$/;
const MAX_SAFE_MICRO_USD = BigInt(Number.MAX_SAFE_INTEGER);

export interface ParsedPriceDecimalV1 {
  readonly lexeme: string;
  readonly microUsd: number;
}

export interface ParsedInventoryPriceV1 {
  readonly valid: boolean;
  readonly hourlyPriceMicroUsd: number | null;
  readonly secureLexeme: string | null;
}

export interface ParsedPodPriceV1 {
  readonly valid: boolean;
  readonly hourlyPriceMicroUsd: number | null;
  readonly source: "adjusted" | "cost" | null;
  readonly adjustedLexeme: string | null;
  readonly costLexeme: string | null;
}

export function parsePriceDecimalV1(lexeme: string): ParsedPriceDecimalV1 | null {
  if (!PRICE_DECIMAL_V1.test(lexeme)) return null;
  const [whole = "", fraction = ""] = lexeme.split(".");
  const microUsd = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (microUsd > MAX_SAFE_MICRO_USD) return null;
  return Object.freeze({ lexeme, microUsd: Number(microUsd) });
}

/** Inventory secure price must be a JSON number token or exact null. */
export function parseInventorySecurePriceV1(price: unknown): ParsedInventoryPriceV1 {
  if (typeof price !== "object" || price === null || Array.isArray(price) || !Object.hasOwn(price, "secure")) {
    return Object.freeze({ valid: false, hourlyPriceMicroUsd: null, secureLexeme: null });
  }
  const record = price as Readonly<Record<string, unknown>>;
  if (record.secure === null) {
    return Object.freeze({ valid: true, hourlyPriceMicroUsd: null, secureLexeme: null });
  }
  const token = getLosslessJsonNumberToken(record, "secure");
  const parsed = token === null ? null : parsePriceDecimalV1(token);
  if (typeof record.secure !== "number" || parsed === null) {
    return Object.freeze({ valid: false, hourlyPriceMicroUsd: null, secureLexeme: token });
  }
  return Object.freeze({
    valid: true,
    hourlyPriceMicroUsd: parsed.microUsd,
    secureLexeme: parsed.lexeme,
  });
}

/**
 * Pod price is valid only when both documented fields exist with their exact
 * representations. Adjusted wins unless it is the literal JSON null.
 */
export function parsePodPriceV1(pod: unknown): ParsedPodPriceV1 {
  if (
    typeof pod !== "object" ||
    pod === null ||
    Array.isArray(pod) ||
    !Object.hasOwn(pod, "adjustedCostPerHr") ||
    !Object.hasOwn(pod, "costPerHr")
  ) {
    return Object.freeze({
      valid: false,
      hourlyPriceMicroUsd: null,
      source: null,
      adjustedLexeme: null,
      costLexeme: null,
    });
  }
  const record = pod as Readonly<Record<string, unknown>>;
  const costLexeme = typeof record.costPerHr === "string" ? record.costPerHr : null;
  const cost = costLexeme === null ? null : parsePriceDecimalV1(costLexeme);
  if (cost === null) {
    return Object.freeze({
      valid: false,
      hourlyPriceMicroUsd: null,
      source: null,
      adjustedLexeme: getLosslessJsonNumberToken(record, "adjustedCostPerHr"),
      costLexeme,
    });
  }
  if (record.adjustedCostPerHr === null) {
    return Object.freeze({
      valid: true,
      hourlyPriceMicroUsd: cost.microUsd,
      source: "cost",
      adjustedLexeme: null,
      costLexeme,
    });
  }
  const adjustedLexeme = getLosslessJsonNumberToken(record, "adjustedCostPerHr");
  const adjusted = adjustedLexeme === null ? null : parsePriceDecimalV1(adjustedLexeme);
  if (typeof record.adjustedCostPerHr !== "number" || adjusted === null) {
    return Object.freeze({
      valid: false,
      hourlyPriceMicroUsd: null,
      source: null,
      adjustedLexeme,
      costLexeme,
    });
  }
  return Object.freeze({
    valid: true,
    hourlyPriceMicroUsd: adjusted.microUsd,
    source: "adjusted",
    adjustedLexeme,
    costLexeme,
  });
}

export function formatHourlyMicroUsdV1(microUsd: number | null): string {
  if (!Number.isSafeInteger(microUsd) || microUsd === null || microUsd < 0) return "—";
  const value = BigInt(microUsd);
  const whole = value / 1_000_000n;
  const fractional = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `$${whole.toString()}${fractional.length === 0 ? "" : `.${fractional}`}/hr`;
}
