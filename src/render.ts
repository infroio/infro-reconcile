/**
 * Printing the result.
 *
 * TWO RULES
 *
 * A row that could not be compared says why, in the cell where the number
 * would have been. An em dash with no explanation is how a reader decides the
 * tool is broken, or worse, reads it as a zero.
 *
 * Money in `--json` is never a JSON number. A double cannot hold a month of
 * micro-USD exactly, and the consumer of this output is a spreadsheet or
 * another program that will sum it. Every amount goes out twice: `*_micros` as
 * an exact integer string, and `*_usd` as an exact decimal string.
 */

import type { Comparison, DayRow } from "./compare.js";
import { confidenceNotes } from "./compare.js";
import { formatRate, formatUsd, microsToUsdString, usdDecimals } from "./money.js";
import type { CostProvider } from "./providers/index.js";

const DASH = "—";

const STATUS_NOTE: Record<DayRow["status"], string> = {
  compared: "",
  "outside-export": "not in export",
  "not-reported": "not reported by provider",
};

interface Column {
  header: string;
  align: "left" | "right";
  cell: (row: DayRow) => string;
}

function pad(text: string, width: number, align: "left" | "right"): string {
  const visible = [...text].length;
  const fill = " ".repeat(Math.max(0, width - visible));
  return align === "right" ? fill + text : text + fill;
}

export function renderTable(comparison: Comparison, providerLabel: string): string {
  // One precision for every money cell in the table, because the reader is
  // checking that one column minus another equals a third, and a column of
  // mixed precision does not scan as money at all.
  const amounts: bigint[] = [];
  for (const row of comparison.days) {
    if (row.reportedMicros !== null) amounts.push(row.reportedMicros);
    if (row.usageMicros !== null) amounts.push(row.usageMicros);
    if (row.reportedMicros !== null && row.usageMicros !== null) {
      amounts.push(row.reportedMicros - row.usageMicros);
    }
  }
  const decimals = usdDecimals(amounts);

  const columns: Column[] = [
    { header: "UTC day", align: "left", cell: (row) => row.day },
    {
      header: `${providerLabel} billed`,
      align: "right",
      cell: (row) => (row.reportedMicros === null ? DASH : formatUsd(row.reportedMicros, { decimals })),
    },
    {
      header: "your export",
      align: "right",
      cell: (row) => (row.usageMicros === null ? DASH : formatUsd(row.usageMicros, { decimals })),
    },
    {
      header: "variance",
      align: "right",
      cell: (row) =>
        row.status === "compared" && row.reportedMicros !== null && row.usageMicros !== null
          ? formatUsd(row.reportedMicros - row.usageMicros, { sign: true, decimals })
          : DASH,
    },
    {
      header: "",
      align: "right",
      cell: (row) =>
        row.status === "compared" && row.reportedMicros !== null && row.usageMicros !== null
          ? row.reportedMicros === 0n
            ? DASH
            : formatRate(Number(row.reportedMicros - row.usageMicros) / Number(row.reportedMicros))
          : "",
    },
    { header: "", align: "left", cell: (row) => STATUS_NOTE[row.status] },
  ];

  const body = comparison.days.map((row) => columns.map((column) => column.cell(row)));
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...body.map((row) => [...(row[index] ?? "")].length), 0),
  );

  const lines: string[] = [];
  lines.push(columns.map((column, i) => pad(column.header, widths[i] ?? 0, column.align)).join("  ").trimEnd());
  // No rule under a column with no heading: the percentage and the status note
  // are annotations on the row beside them, not columns of their own.
  lines.push(
    widths
      .map((width, i) => (columns[i]?.header ? "-".repeat(width) : " ".repeat(width)))
      .join("  ")
      .trimEnd(),
  );
  for (const row of body) {
    lines.push(row.map((cell, i) => pad(cell, widths[i] ?? 0, columns[i]?.align ?? "left")).join("  ").trimEnd());
  }

  return lines.join("\n");
}

export function renderSummary(comparison: Comparison, provider: CostProvider): string {
  const lines: string[] = [];
  const { excluded } = comparison;

  if (comparison.comparedDays === 0) {
    lines.push("No day had figures from both sides. Nothing was compared.");
  } else {
    const dayWord = comparison.comparedDays === 1 ? "day" : "days";
    // Three figures the reader will subtract from each other, so one precision
    // across all three — the same rule as the table.
    const decimals = usdDecimals([
      comparison.reportedMicros,
      comparison.usageMicros,
      comparison.differenceMicros,
    ]);
    lines.push(
      `Over ${comparison.comparedDays} comparable ${dayWord}: ` +
        `${provider.label} billed ${formatUsd(comparison.reportedMicros, { decimals })}, ` +
        `your export accounts for ${formatUsd(comparison.usageMicros, { decimals })}, ` +
        `variance ${formatUsd(comparison.differenceMicros, { sign: true, decimals })} (${formatRate(comparison.rate)}).`,
    );
    lines.push(
      comparison.differenceMicros === 0n
        ? "  The two agree exactly."
        : comparison.differenceMicros > 0n
          ? `  Positive: ${provider.label} billed more than your records account for.`
          : `  Negative: your records account for more than ${provider.label} billed.`,
    );
  }

  if (comparison.reportedOutsideExportMicros > 0n) {
    lines.push(
      `${formatUsd(comparison.reportedOutsideExportMicros)} was billed on days your export does not reach. ` +
        "Not counted above.",
    );
  }
  if (comparison.usageNotReportedMicros > 0n) {
    lines.push(
      `${formatUsd(comparison.usageNotReportedMicros)} of your export falls on days the provider reported ` +
        "nothing for. Not counted above.",
    );
  }

  const parts: string[] = [];
  if (excluded.unpriced > 0) {
    const top = [...excluded.unpricedModels.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([model, count]) => `${model} x${count}`)
      .join(", ");
    const tokens =
      excluded.unpricedInputTokens + excluded.unpricedOutputTokens > 0
        ? ` carrying ${(excluded.unpricedInputTokens + excluded.unpricedOutputTokens).toLocaleString()} tokens`
        : "";
    parts.push(`${excluded.unpriced.toLocaleString()} unpriced${tokens} (${top})`);
  }
  if (excluded.unattributed > 0) {
    parts.push(
      `${excluded.unattributed.toLocaleString()} unattributed (${excluded.unattributedExamples.join("; ")})`,
    );
  }
  const otherTotal = [...excluded.otherVendor.values()].reduce((sum, count) => sum + count, 0);
  if (otherTotal > 0) {
    const detail = [...excluded.otherVendor.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([reason, count]) => `${count} ${reason}`)
      .join(", ");
    parts.push(`${otherTotal.toLocaleString()} for other providers (${detail})`);
  }
  if (excluded.outsideWindow > 0) {
    parts.push(`${excluded.outsideWindow.toLocaleString()} outside the window`);
  }
  if (parts.length > 0) lines.push(`Rows excluded: ${parts.join("; ")}.`);

  if (excluded.pricedFromRateCard > 0) {
    lines.push(
      `${excluded.pricedFromRateCard.toLocaleString()} rows were priced from your --rates card, not from ` +
        "a cost column. Those are your figures, not the provider's.",
    );
  }

  const notes = confidenceNotes(comparison);
  if (notes.length > 0) {
    lines.push("");
    lines.push("Before acting on this:");
    for (const note of notes) lines.push(`  - ${note}`);
  }

  if (provider.caveats.length > 0) {
    lines.push("");
    lines.push(`Known gaps in ${provider.label}'s cost endpoint:`);
    for (const caveat of provider.caveats) lines.push(`  - ${caveat}`);
  }

  return lines.join("\n");
}

/** The provider's figures alone, when no export was supplied to compare. */
export function renderReportOnly(comparison: Comparison, provider: CostProvider): string {
  const rows = comparison.days.filter((row) => row.reportedMicros !== null);
  const total = rows.reduce((sum, row) => sum + (row.reportedMicros ?? 0n), 0n);

  const width = Math.max(...rows.map((row) => formatUsd(row.reportedMicros ?? 0n).length), 7);
  const lines = rows.map((row) => `${row.day}  ${pad(formatUsd(row.reportedMicros ?? 0n), width, "right")}`);
  lines.push("-".repeat(12 + width));
  lines.push(`total       ${pad(formatUsd(total), width, "right")}`);
  lines.push("");
  lines.push(
    `${provider.label} billed ${formatUsd(total)} between ${comparison.from} and ${comparison.to} (UTC, inclusive).`,
  );
  lines.push("No usage export was supplied, so nothing was compared. Pass --usage <file> to reconcile.");
  return lines.join("\n");
}

export function renderJson(
  comparison: Comparison,
  provider: CostProvider,
  meta: { version: string; adapter: string | null; usageFile: string | null; generatedAt: string },
): string {
  const { excluded } = comparison;

  return JSON.stringify(
    {
      tool: "infro-reconcile",
      version: meta.version,
      generated_at: meta.generatedAt,
      provider: provider.id,
      window: { from: comparison.from, to: comparison.to, timezone: "UTC", inclusive: true },
      usage_export: meta.usageFile
        ? { file: meta.usageFile, adapter: meta.adapter, coverage: comparison.coverage }
        : null,
      // Totals cover `status: "compared"` days only. The two amounts below the
      // summary are what falls outside that set, so the figures reconcile.
      summary: {
        compared_days: comparison.comparedDays,
        reported_micros: comparison.reportedMicros.toString(),
        reported_usd: microsToUsdString(comparison.reportedMicros),
        usage_micros: comparison.usageMicros.toString(),
        usage_usd: microsToUsdString(comparison.usageMicros),
        difference_micros: comparison.differenceMicros.toString(),
        difference_usd: microsToUsdString(comparison.differenceMicros),
        /** Positive means the provider billed more than the export accounts for. */
        variance_rate: comparison.rate,
        reported_outside_export_micros: comparison.reportedOutsideExportMicros.toString(),
        usage_not_reported_micros: comparison.usageNotReportedMicros.toString(),
      },
      days: comparison.days.map((row) => ({
        day: row.day,
        status: row.status,
        reported_micros: row.reportedMicros === null ? null : row.reportedMicros.toString(),
        reported_usd: row.reportedMicros === null ? null : microsToUsdString(row.reportedMicros),
        usage_micros: row.usageMicros === null ? null : row.usageMicros.toString(),
        usage_usd: row.usageMicros === null ? null : microsToUsdString(row.usageMicros),
        difference_micros:
          row.status === "compared" && row.reportedMicros !== null && row.usageMicros !== null
            ? (row.reportedMicros - row.usageMicros).toString()
            : null,
        rows: row.rows,
        priced_rows: row.pricedRows,
      })),
      excluded: {
        unpriced_rows: excluded.unpriced,
        unpriced_models: Object.fromEntries(excluded.unpricedModels),
        unpriced_input_tokens: excluded.unpricedInputTokens,
        unpriced_output_tokens: excluded.unpricedOutputTokens,
        unattributed_rows: excluded.unattributed,
        other_provider_rows: Object.fromEntries(excluded.otherVendor),
        outside_window_rows: excluded.outsideWindow,
        zero_cost_rows: excluded.zeroCost,
        priced_from_rate_card_rows: excluded.pricedFromRateCard,
      },
      notes: confidenceNotes(comparison),
      provider_caveats: provider.caveats,
    },
    null,
    2,
  );
}
