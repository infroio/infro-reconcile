/**
 * Money, and the two conversions this whole tool exists to get right.
 *
 * THE TRAP, STATED ONCE, HERE
 *
 * The two providers report the same quantity in different units:
 *
 *   OpenAI     GET /v1/organization/costs
 *              `amount.value` is DOLLARS, as a JSON number.
 *              e.g. 0.13080438340307526  ->  about thirteen cents
 *
 *   Anthropic  GET /v1/organizations/cost_report
 *              `amount` is CENTS, as a decimal string. Their docs, verbatim:
 *              "All costs in USD, reported as decimal strings in lowest units
 *              (cents)".
 *              e.g. "41280.000000"  ->  $412.80
 *
 * Reading one as the other is a hundredfold error, and it is the kind that
 * survives review: a variance is *supposed* to be surprising, so a number that
 * is 100x wrong reads as a finding rather than as a bug. It has been shipped by
 * other people — there is a public pull request titled "Fix Anthropic cost
 * report 100x overstatement (cents parsed as dollars)".
 *
 * So nothing outside this file ever handles a provider's raw amount. Each
 * adapter converts at the boundary, into micro-USD, and `test/money.test.ts`
 * asserts that the two conversions do not collapse into each other.
 *
 * WHY MICRO-USD, AND WHY bigint
 *
 * A dollar float cannot represent a tenth of a cent, and a month of inference
 * is a long sum of tenths of a cent. Micro-USD (1e-6 USD) is the unit the
 * cheapest single request can be expressed in without rounding to zero, and
 * bigint is the only type in JavaScript that adds a million of them without
 * disagreeing with itself depending on the order.
 *
 * Both endpoints re-verified against the vendors' live documentation on
 * 2026-09-20.
 */

export const MICROS_PER_USD = 1_000_000n;
export const MICROS_PER_CENT = 10_000n;

/** Plain decimal, no exponent. The exact path. */
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
/** Exponent notation, which JSON serialisers emit for very small numbers. */
const EXPONENTIAL = /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/;

/**
 * A decimal string scaled by `10 ** fractionDigits`, exactly.
 *
 * Exactly, because these strings are money: a large Anthropic figure passed
 * through `Number` loses its tail, and Anthropic sends a string precisely so
 * the reader does not have to. The discarded tail is rounded half-up on the
 * magnitude, so -0.5 and 0.5 round away from zero alike.
 *
 * Returns null for anything that is not a number — an empty cell, a dash, a
 * header that slipped into the body. Null means "no figure here", which the
 * caller must report as unpriced rather than as zero.
 */
export function scaledDecimal(raw: string, fractionDigits: number): bigint | null {
  const value = raw.trim();
  if (!value) return null;

  if (EXPONENTIAL.test(value)) {
    // A float is the correct reading of something a float wrote. It is used
    // only for the small magnitudes that produce exponent notation in the
    // first place, where a double is exact well past the micro.
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return roundToBigInt(parsed * Number(10n ** BigInt(fractionDigits)));
  }

  if (!DECIMAL.test(value)) return null;

  const negative = value.startsWith("-");
  const unsigned = value.replace(/^[+-]/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");

  const kept = fraction.slice(0, fractionDigits).padEnd(fractionDigits, "0");
  const dropped = fraction.slice(fractionDigits);

  let scaled = BigInt(whole || "0") * 10n ** BigInt(fractionDigits) + BigInt(kept || "0");
  // Half-up on the magnitude: the first discarded digit decides.
  if (dropped && Number(dropped[0]) >= 5) scaled += 1n;

  return negative ? -scaled : scaled;
}

function roundToBigInt(value: number): bigint {
  if (!Number.isFinite(value)) return 0n;
  // Math.round is half-up toward +Infinity, which rounds -0.5 to -0, so the
  // magnitude is rounded and the sign reapplied.
  const rounded = Math.round(Math.abs(value));
  return value < 0 ? -BigInt(rounded) : BigInt(rounded);
}

/**
 * OpenAI's unit: dollars, as a JSON number, to micro-USD.
 *
 * Rounded once here rather than carried onward, because a float can only land
 * *near* a micro and the output of this tool is a small difference between two
 * large numbers.
 */
export function dollarsFloatToMicros(value: number): bigint {
  if (!Number.isFinite(value)) return 0n;
  return roundToBigInt(value * 1_000_000);
}

/**
 * Anthropic's unit: cents, as a decimal string, to micro-USD.
 *
 * Four fractional digits of a cent is exactly one micro-USD.
 */
export function centsDecimalToMicros(value: string): bigint | null {
  return scaledDecimal(value, 4);
}

/**
 * A usage export's unit: dollars, however the exporter wrote them.
 *
 * LiteLLM's `spend` and Langfuse's `total_cost` are both USD. A CSV gives them
 * as strings and a JSONL gives them as numbers; both arrive here as strings so
 * that one parser decides, and so that the exact path is taken whenever the
 * input is exact.
 */
export function usdDecimalToMicros(value: string): bigint | null {
  return scaledDecimal(value, 6);
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * Micro-USD as `$1,234.56`.
 *
 * Two decimals when the amount is whole cents, six when it is not. A charge of
 * 24 micro-USD is real money on a cheap model, and printing it as `$0.00`
 * beside a four-figure total is how a reader concludes a column does not add
 * up. This is the same rule the INFRO consoles follow, for the same reason.
 *
 * PASS `decimals` FOR ANYTHING THAT WILL BE READ AS A COLUMN.
 *
 * Deciding per value is right for one figure in a sentence and wrong for a
 * column: `$412.804200` above `$388.19` does not scan as money, and the reader
 * of this particular table is checking that one column minus another equals a
 * third. `usdDecimals` picks one precision for a whole set.
 */
export function formatUsd(micros: bigint, options: { sign?: boolean; decimals?: number } = {}): string {
  const negative = micros < 0n;
  const magnitude = negative ? -micros : micros;

  const decimals = clampDecimals(options.decimals ?? decimalsFor(magnitude));
  // Scale down to the requested precision, rounding half-up on the magnitude.
  // Rounding rather than truncating, because truncation makes a column stop
  // adding up in the reader's favour, which is the direction nobody notices.
  const divisor = 10n ** BigInt(6 - decimals);
  const scaled = (magnitude + divisor / 2n) / divisor;
  const unit = 10n ** BigInt(decimals);

  const text = `${group(scaled / unit)}.${(scaled % unit).toString().padStart(decimals, "0")}`;
  const prefix = negative ? "-$" : options.sign && micros > 0n ? "+$" : "$";
  return prefix + text;
}

function clampDecimals(value: number): number {
  return Math.min(6, Math.max(2, Math.trunc(value)));
}

/** The fewest decimals that still represent this amount exactly, 2 to 6. */
function decimalsFor(magnitude: bigint): number {
  for (let decimals = 2; decimals < 6; decimals += 1) {
    if (magnitude % 10n ** BigInt(6 - decimals) === 0n) return decimals;
  }
  return 6;
}

/**
 * One precision for a set of amounts that will be printed together.
 *
 * The fewest decimals that keep *every* one of them exact. A column has to
 * scan as a column — `$412.804200` above `$388.19` does not — and it has to be
 * exact, because a reader checking that one column minus another equals a
 * third will find a rounded column a cent out and conclude the tool cannot
 * add up. Those two together leave exactly one answer: pad them all to the
 * precision the most precise one needs, and no further.
 */
export function usdDecimals(values: Iterable<bigint>): number {
  let decimals = 2;
  for (const value of values) {
    decimals = Math.max(decimals, decimalsFor(value < 0n ? -value : value));
    if (decimals === 6) break;
  }
  return decimals;
}

function group(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Micro-USD as a plain decimal string of dollars. For JSON, never a float. */
export function microsToUsdString(micros: bigint): string {
  const negative = micros < 0n;
  const magnitude = negative ? -micros : micros;
  const whole = magnitude / MICROS_PER_USD;
  const fraction = (magnitude % MICROS_PER_USD).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** A rate as a percentage, one decimal. Null in, em dash out. */
export function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  const percent = rate * 100;
  const sign = percent > 0 ? "+" : "";
  return `${sign}${percent.toFixed(1)}%`;
}
