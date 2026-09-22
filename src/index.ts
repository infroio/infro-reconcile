/**
 * The library surface, for anyone who wants the pieces without the CLI.
 *
 * The comparison and the two cost adapters are the useful parts; the argument
 * parsing is not. `run()` is exported so the CLI can be driven from a test or
 * a wrapper without spawning a process.
 */

export { run } from "./cli.js";
export { compare, confidenceNotes } from "./compare.js";
export type { Comparison, CompareInput, DayRow, DayStatus, ExcludedCounts } from "./compare.js";

export {
  centsDecimalToMicros,
  dollarsFloatToMicros,
  formatRate,
  formatUsd,
  microsToUsdString,
  usdDecimalToMicros,
  usdDecimals,
} from "./money.js";

export { PROVIDERS, PROVIDER_IDS, providerFor, anthropic, openai } from "./providers/index.js";
export type { CostDay, CostProvider, FetchOptions } from "./providers/index.js";
export { CostApiError } from "./providers/index.js";

export { ADAPTERS, adapterFor, detectAdapter, parseRows, parseTimestamp } from "./usage/adapters.js";
export type { AdapterDefinition, UsageRow } from "./usage/adapters.js";
export { readRows, parseCsv, detectFormat, UsageFileError } from "./usage/read.js";
export type { Row, UsageFormat } from "./usage/read.js";
export { parseRateCard, priceTokens, rateFor } from "./usage/rates.js";
export type { Rate, RateCard } from "./usage/rates.js";
export { attribute } from "./usage/vendor.js";
export type { Attribution, Vendor } from "./usage/vendor.js";

export {
  addDays,
  daysBetween,
  parseDay,
  resolveWindow,
  utcDay,
  windowInstants,
  WindowError,
  DEFAULT_WINDOW_DAYS,
} from "./window.js";
export type { Window, WindowRequest } from "./window.js";

export { VERSION, USER_AGENT } from "./version.js";
