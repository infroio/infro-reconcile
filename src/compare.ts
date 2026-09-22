/**
 * The comparison, and the four things it refuses to do.
 *
 * 1. A DAY THE EXPORT COVERS AND THE PROVIDER DID NOT REPORT IS RECORDED.
 *    It is the most interesting row the table can hold — it means either the
 *    export contains requests the provider has not billed, or the provider's
 *    figure has not settled, or the rows belong to somebody else entirely. It
 *    is never dropped, and it is never counted as a provider total of zero.
 *
 * 2. "THE EXPORT COVERS THIS DAY" AND "THE EXPORT HAS NO ROWS FOR IT" ARE
 *    DIFFERENT FACTS. Coverage is the span between the export's own first and
 *    last row. A day inside that span with no rows is a real silence and is
 *    compared. A day outside it was never in the file, so no comparison is
 *    possible and the row says so. Conflating the two turns a short export
 *    into a fictitious hundred-percent variance.
 *
 * 3. UNPRICED, UNATTRIBUTED AND OTHER-VENDOR ROWS ARE COUNTED AND NAMED,
 *    NEVER FOLDED IN AS ZERO. A row with tokens and no cost makes the export
 *    side low by an unknown amount. Saying so is the difference between "your
 *    rates are wrong" and "we have no rate", which have different fixes.
 *
 * 4. THE TOTAL IS OVER COMPARABLE DAYS ONLY, AND SAYS SO. Summing a provider
 *    total that spans more days than the export and dividing produces a
 *    headline number that is mostly window mismatch.
 *
 * SIGN CONVENTION
 *
 * Positive variance means the provider billed MORE than the export accounts
 * for — your records are under. This is the same convention the INFRO gateway
 * uses internally, and it is the direction that matters: being under is a
 * rate you are not modelling; being over is usually double counting.
 */

import type { CostDay } from "./providers/index.js";
import { attribute, type Vendor } from "./usage/vendor.js";
import { priceTokens, rateFor, type RateCard } from "./usage/rates.js";
import type { UsageRow } from "./usage/adapters.js";
import { utcDay } from "./window.js";

export type DayStatus =
  /** Both sides present. The only rows that enter the totals. */
  | "compared"
  /** The provider billed for a day the export does not reach. */
  | "outside-export"
  /** The export covers the day and the provider reported nothing for it. */
  | "not-reported";

export interface DayRow {
  day: string;
  status: DayStatus;
  /** Null when the provider reported nothing for this day. */
  reportedMicros: bigint | null;
  /** Null when the export does not cover this day. */
  usageMicros: bigint | null;
  /** Rows in the export attributed to this provider on this day. */
  rows: number;
  /** Of those, the ones that carried a usable cost. */
  pricedRows: number;
}

export interface ExcludedCounts {
  /** Attributed to a different provider. Keyed by the reason. */
  otherVendor: Map<string, number>;
  /** Could not be attributed at all. */
  unattributed: number;
  unattributedExamples: string[];
  /** Attributed here, inside the window, but carrying no usable cost. */
  unpriced: number;
  unpricedModels: Map<string, number>;
  unpricedInputTokens: number;
  unpricedOutputTokens: number;
  /** Attributed here but outside the window entirely. */
  outsideWindow: number;
  /** Cost present and exactly zero — ambiguous in at least one exporter. */
  zeroCost: number;
  /** Priced from `--rates` rather than from a cost column. */
  pricedFromRateCard: number;
}

export interface Comparison {
  provider: string;
  from: string;
  to: string;
  days: DayRow[];
  /** The export's own first and last day, or null when it has no usable rows. */
  coverage: { from: string; to: string } | null;

  /** Totals over `status === "compared"` days only. */
  comparedDays: number;
  reportedMicros: bigint;
  usageMicros: bigint;
  differenceMicros: bigint;
  /** `difference / reported`, or null when there is nothing to divide by. */
  rate: number | null;

  /** Outside the comparable set, reported so the totals cannot mislead. */
  reportedOutsideExportMicros: bigint;
  usageNotReportedMicros: bigint;

  excluded: ExcludedCounts;
}

export interface CompareInput {
  provider: Vendor & string;
  from: string;
  to: string;
  costDays: CostDay[];
  usage: UsageRow[];
  rateCard?: RateCard | null;
  /** Skip vendor attribution: the export is already provider-specific. */
  allRows?: boolean;
}

export function compare(input: CompareInput): Comparison {
  const excluded: ExcludedCounts = {
    otherVendor: new Map(),
    unattributed: 0,
    unattributedExamples: [],
    unpriced: 0,
    unpricedModels: new Map(),
    unpricedInputTokens: 0,
    unpricedOutputTokens: 0,
    outsideWindow: 0,
    zeroCost: 0,
    pricedFromRateCard: 0,
  };

  // Coverage is computed over EVERY row in the file, before any filtering.
  // The question it answers is "did this export reach this day at all", which
  // is a property of the file rather than of the provider being reconciled.
  let coverageFrom: string | null = null;
  let coverageTo: string | null = null;
  for (const row of input.usage) {
    const day = utcDay(row.at);
    if (coverageFrom === null || day < coverageFrom) coverageFrom = day;
    if (coverageTo === null || day > coverageTo) coverageTo = day;
  }
  const coverage = coverageFrom && coverageTo ? { from: coverageFrom, to: coverageTo } : null;

  const usageByDay = new Map<string, { micros: bigint; rows: number; priced: number }>();

  for (const row of input.usage) {
    if (!input.allRows) {
      const { vendor, reason } = attribute(row.model, row.provider);
      if (vendor === "unknown") {
        excluded.unattributed += 1;
        if (excluded.unattributedExamples.length < 3 && !excluded.unattributedExamples.includes(reason)) {
          excluded.unattributedExamples.push(reason);
        }
        continue;
      }
      if (vendor !== input.provider) {
        excluded.otherVendor.set(reason, (excluded.otherVendor.get(reason) ?? 0) + 1);
        continue;
      }
    }

    const day = utcDay(row.at);
    if (day < input.from || day > input.to) {
      excluded.outsideWindow += 1;
      continue;
    }

    const entry = usageByDay.get(day) ?? { micros: 0n, rows: 0, priced: 0 };
    entry.rows += 1;

    let micros = row.micros;
    if (micros === null && input.rateCard) {
      const rate = rateFor(input.rateCard, row.model);
      if (rate) {
        const priced = priceTokens(rate, row.inputTokens, row.outputTokens);
        if (priced !== null) {
          micros = priced;
          excluded.pricedFromRateCard += 1;
        }
      }
    }

    if (micros === null) {
      excluded.unpriced += 1;
      excluded.unpricedModels.set(row.model, (excluded.unpricedModels.get(row.model) ?? 0) + 1);
      excluded.unpricedInputTokens += row.inputTokens ?? 0;
      excluded.unpricedOutputTokens += row.outputTokens ?? 0;
    } else {
      entry.micros += micros;
      entry.priced += 1;
      if (row.zeroCost) excluded.zeroCost += 1;
    }

    usageByDay.set(day, entry);
  }

  const reportedByDay = new Map(input.costDays.map((day) => [day.day, day]));

  // Every day either side has an opinion about, inside the window.
  const days = [...new Set([...reportedByDay.keys(), ...usageByDay.keys()])]
    .filter((day) => day >= input.from && day <= input.to)
    .sort();

  const rows: DayRow[] = [];
  let reported = 0n;
  let usage = 0n;
  let comparedDays = 0;
  let reportedOutside = 0n;
  let usageNotReported = 0n;

  for (const day of days) {
    const cost = reportedByDay.get(day) ?? null;
    const used = usageByDay.get(day) ?? null;
    const covered = coverage !== null && day >= coverage.from && day <= coverage.to;

    if (cost && !covered) {
      // The provider billed for a day this file never reached. Shown, never
      // compared: the export is not claiming zero, it is simply not present.
      reportedOutside += cost.micros;
      rows.push({
        day,
        status: "outside-export",
        reportedMicros: cost.micros,
        usageMicros: null,
        rows: 0,
        pricedRows: 0,
      });
      continue;
    }

    if (!cost && used) {
      // The interesting one. The export covers this day and has rows for it,
      // and the provider reported nothing.
      usageNotReported += used.micros;
      rows.push({
        day,
        status: "not-reported",
        reportedMicros: null,
        usageMicros: used.micros,
        rows: used.rows,
        pricedRows: used.priced,
      });
      continue;
    }

    if (!cost) continue;

    const usedMicros = used?.micros ?? 0n;
    reported += cost.micros;
    usage += usedMicros;
    comparedDays += 1;
    rows.push({
      day,
      status: "compared",
      reportedMicros: cost.micros,
      usageMicros: usedMicros,
      rows: used?.rows ?? 0,
      pricedRows: used?.priced ?? 0,
    });
  }

  const difference = reported - usage;

  return {
    provider: input.provider,
    from: input.from,
    to: input.to,
    days: rows,
    coverage,
    comparedDays,
    reportedMicros: reported,
    usageMicros: usage,
    differenceMicros: difference,
    // Null rather than zero when the provider reported nothing: no bill is not
    // the same as a bill matched exactly, and only one of those is good news.
    rate: reported === 0n ? null : Number(difference) / Number(reported),
    reportedOutsideExportMicros: reportedOutside,
    usageNotReportedMicros: usageNotReported,
    excluded,
  };
}

/**
 * Whether the headline percentage is worth believing.
 *
 * Not a threshold on the number — a caveat on the comparison that produced it.
 * A variance computed over two days, or one where a fifth of the rows carried
 * no price, is arithmetic rather than evidence, and the output has to say
 * which it is before anybody acts on it.
 */
/** "1 row" / "1,204 rows". A tool that says "1 rows" is not read carefully. */
function rowCount(count: number): string {
  return `${count.toLocaleString()} row${count === 1 ? "" : "s"}`;
}

function wereWas(count: number): string {
  return count === 1 ? "was" : "were";
}

export function confidenceNotes(comparison: Comparison): string[] {
  const notes: string[] = [];

  if (comparison.comparedDays === 0) {
    notes.push("No day had figures from both sides, so no variance was computed.");
    return notes;
  }
  if (comparison.comparedDays < 3) {
    notes.push(
      `Only ${comparison.comparedDays} day${comparison.comparedDays === 1 ? "" : "s"} could be compared. ` +
        "A single day's gap is usually timing, not drift.",
    );
  }
  if (comparison.excluded.unpriced > 0) {
    notes.push(
      `${rowCount(comparison.excluded.unpriced)} carried no cost and ${wereWas(comparison.excluded.unpriced)} ` +
        "excluded, so the export side is low by an unknown amount. Supply --rates to price them.",
    );
  }
  if (comparison.excluded.zeroCost > 0) {
    notes.push(
      `${rowCount(comparison.excluded.zeroCost)} carried a cost of exactly 0. ` +
        "Some exporters cannot tell a free request from one they had no rate for.",
    );
  }
  if (comparison.excluded.unattributed > 0) {
    notes.push(
      `${rowCount(comparison.excluded.unattributed)} could not be attributed to a provider ` +
        `and ${wereWas(comparison.excluded.unattributed)} excluded. ` +
        "Use --all-rows if this export is already provider-specific.",
    );
  }

  return notes;
}
