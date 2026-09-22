/**
 * An optional rate card, supplied by the user, for exports that carry tokens
 * and no cost.
 *
 * WHY THIS IS A FILE YOU PASS AND NOT A TABLE WE SHIP
 *
 * A rate card compiled into a CLI is wrong the week after a vendor changes a
 * price, and it is wrong *silently*: the variance it produces looks exactly
 * like the finding this tool exists to surface. Worse, it would be wrong for
 * anybody on a negotiated rate, which is most of the people for whom a
 * reconciliation is worth running at all.
 *
 * So there is no built-in table. Your rates are yours; point at them and the
 * output records that the priced side came from your card rather than from a
 * provider's invoice. Without one, token-only rows are reported as unpriced,
 * which is a smaller and more honest answer than a guess.
 *
 *   {
 *     "gpt-4o":            { "input_per_1m": 2.50,  "output_per_1m": 10.00 },
 *     "claude-sonnet-4-5": { "input_per_1m": 3,     "output_per_1m": 15 }
 *   }
 *
 * A key matches a model exactly, or as the longest prefix of it — so
 * `claude-sonnet-4-5` prices `claude-sonnet-4-5-20250929` without anybody
 * maintaining a dated key per release.
 */

import { usdDecimalToMicros } from "../money.js";
import { UsageFileError } from "./read.js";

export interface Rate {
  inputPerMillionMicros: bigint;
  outputPerMillionMicros: bigint;
}

export interface RateCard {
  rates: Map<string, Rate>;
  /** Longest first, so prefix matching is a scan that stops at the best hit. */
  keys: string[];
}

export function parseRateCard(text: string): RateCard {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageFileError(`The rates file is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageFileError("The rates file must be a JSON object keyed by model name.");
  }

  const rates = new Map<string, Rate>();
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      throw new UsageFileError(`Rate for "${model}" must be an object with input_per_1m and output_per_1m.`);
    }
    const entry = value as Record<string, unknown>;
    const input = usdDecimalToMicros(String(entry["input_per_1m"] ?? entry["input"] ?? ""));
    const output = usdDecimalToMicros(String(entry["output_per_1m"] ?? entry["output"] ?? ""));
    if (input === null || output === null) {
      throw new UsageFileError(
        `Rate for "${model}" needs numeric input_per_1m and output_per_1m, in USD per million tokens.`,
      );
    }
    rates.set(model.toLowerCase(), {
      inputPerMillionMicros: input,
      outputPerMillionMicros: output,
    });
  }

  if (rates.size === 0) throw new UsageFileError("The rates file is empty.");

  return { rates, keys: [...rates.keys()].sort((a, b) => b.length - a.length) };
}

export function rateFor(card: RateCard, model: string): Rate | null {
  const name = model.toLowerCase();
  const exact = card.rates.get(name);
  if (exact) return exact;
  // Strip a routing prefix before prefix-matching, so `openai/gpt-4o` finds a
  // card keyed on `gpt-4o`.
  const bare = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
  for (const key of card.keys) {
    if (name.startsWith(key) || bare.startsWith(key)) return card.rates.get(key) ?? null;
  }
  return null;
}

/**
 * Price a row from the card.
 *
 * Returns null when either side is missing a count, because half a price is
 * not a price — a row with output tokens and no input count would be billed
 * below its true cost, and the resulting variance would point at the provider
 * rather than at the export.
 */
export function priceTokens(
  rate: Rate,
  inputTokens: number | null,
  outputTokens: number | null,
): bigint | null {
  if (inputTokens === null && outputTokens === null) return null;
  const input = BigInt(Math.max(0, inputTokens ?? 0));
  const output = BigInt(Math.max(0, outputTokens ?? 0));
  return (
    (input * rate.inputPerMillionMicros + output * rate.outputPerMillionMicros) / 1_000_000n
  );
}
