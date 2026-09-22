/**
 * Turning somebody's usage export into four facts per row.
 *
 * THE COLUMN CONTRACT, WHICH IS THE WHOLE PUBLIC SURFACE
 *
 * A row needs a timestamp, a model, and either a cost or a token count. That
 * is it. Everything below is a list of the names real exporters give those
 * three things, so that LiteLLM and Langfuse work with no flags and anything
 * else works by renaming at most three columns.
 *
 * NO BUILT-IN PRICE TABLE. THIS IS A DECISION, NOT AN OMISSION.
 *
 * A rate card compiled into a CLI goes stale silently, and a stale rate
 * produces a variance that looks exactly like a finding and is a bug in the
 * tool. That would invert the point of the thing. So a row with tokens and no
 * cost is *unpriced*: counted, named, and excluded from the comparison, with
 * its token totals shown so the gap is a known size. Supply `--rates` and it
 * is priced from your own card, and the output says so.
 *
 * Deliberately the same rule the INFRO gateway follows for its own estimates:
 * where no price is known the answer is unpriced, never a guess.
 */

import { usdDecimalToMicros } from "../money.js";
import type { Row } from "./read.js";

export interface UsageRow {
  /** UTC instant the request happened. */
  at: Date;
  model: string;
  /** Null when the export carried no cost for this row. */
  micros: bigint | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** The export's own provider column, when it has one. */
  provider: string | null;
  /**
   * True when the cost column was present and exactly zero.
   *
   * Reported separately because at least one exporter cannot distinguish it
   * from a missing price: Langfuse's `total_cost` reads from
   * `cost_details['total']`, so a zero there may be a free request or may be a
   * model it had no rate for. Folding those into a total as zero understates
   * the export side by an unknown amount.
   */
  zeroCost: boolean;
}

export interface AdapterDefinition {
  id: string;
  label: string;
  /** Columns whose presence identifies this exporter. */
  fingerprint: string[];
  timestamp: string[];
  model: string[];
  cost: string[];
  inputTokens: string[];
  outputTokens: string[];
  provider: string[];
}

/**
 * LiteLLM's `LiteLLM_SpendLogs`, as exported from the proxy database or the
 * `/spend/logs` endpoint.
 *
 * `spend` is USD. `startTime` is when the request began — the right end to
 * bucket on, because a long-running request billed on the day it *finished*
 * would disagree with a provider that buckets on the day it started.
 *
 * `custom_llm_provider` is the reason this adapter is worth having separately:
 * LiteLLM has already worked out which vendor served the request, including
 * the Bedrock and Vertex cases that a model name alone gets wrong.
 */
const litellm: AdapterDefinition = {
  id: "litellm",
  label: "LiteLLM spend log",
  // `startTime` is deliberately NOT a fingerprint column: Langfuse uses it too,
  // and a tie is resolved by array order, so sharing it made every camelCase
  // Langfuse export detect as LiteLLM — whose cost column is `spend`, which a
  // Langfuse file does not have. The symptom was not an error. It was a clean
  // run reporting every row unpriced. Fingerprints have to discriminate.
  fingerprint: ["spend", "custom_llm_provider"],
  timestamp: ["startTime", "start_time"],
  model: ["model", "model_group"],
  cost: ["spend"],
  inputTokens: ["prompt_tokens"],
  outputTokens: ["completion_tokens"],
  provider: ["custom_llm_provider"],
};

/**
 * Langfuse observations, in either spelling.
 *
 * The blob-storage export is snake_case (`start_time`, `provided_model_name`,
 * `total_cost`); the public API and the UI's CSV are camelCase (`startTime`,
 * `model`, `calculatedTotalCost`). Both are listed rather than chosen between,
 * because a user should not have to know which export they took.
 *
 * Dotted paths read into the nested objects: `cost_details.total` is where the
 * figure actually lives, and `total_cost` is derived from it.
 */
const langfuse: AdapterDefinition = {
  id: "langfuse",
  label: "Langfuse observations export",
  fingerprint: [
    "calculatedTotalCost",
    "total_cost",
    "provided_model_name",
    "usageDetails",
    "usage_details",
    "costDetails",
    "cost_details",
  ],
  timestamp: ["startTime", "start_time", "timestamp", "createdAt", "created_at"],
  model: ["provided_model_name", "model", "modelName", "model_name"],
  cost: ["calculatedTotalCost", "total_cost", "totalCost", "cost_details.total", "costDetails.total"],
  inputTokens: [
    "usage_details.input",
    "usageDetails.input",
    "promptTokens",
    "usage.input",
    "usage.promptTokens",
    "input_usage",
  ],
  outputTokens: [
    "usage_details.output",
    "usageDetails.output",
    "completionTokens",
    "usage.output",
    "usage.completionTokens",
    "output_usage",
  ],
  provider: ["provider", "llm_provider"],
};

/**
 * The documented contract, and the fallback for raw logs.
 *
 * Every spelling anybody reasonably reaches for, so that "export three columns
 * from your own table" is a true instruction rather than an approximate one.
 */
const generic: AdapterDefinition = {
  id: "generic",
  label: "generic usage export",
  fingerprint: [],
  timestamp: [
    "timestamp",
    "time",
    "date",
    "datetime",
    "created_at",
    "createdAt",
    "start_time",
    "startTime",
    "ts",
  ],
  model: ["model", "model_name", "modelName", "model_id", "engine"],
  cost: ["cost", "cost_usd", "costUsd", "spend", "total_cost", "totalCost", "amount", "price", "usd"],
  inputTokens: ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "input"],
  outputTokens: [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
    "output",
  ],
  provider: ["provider", "custom_llm_provider", "vendor", "llm_provider"],
};

export const ADAPTERS: AdapterDefinition[] = [litellm, langfuse, generic];

export function adapterFor(id: string): AdapterDefinition | null {
  return ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

/**
 * Pick the adapter whose fingerprint the file matches best, then check that it
 * can actually read the file.
 *
 * The second half is the important half. A fingerprint is a guess from column
 * names, and a wrong guess does not fail loudly — it produces an adapter whose
 * timestamp or cost column is absent from the file, and the run completes with
 * every row unpriced or every row malformed. That reads as a bad export rather
 * than as a bad guess, so it is the user who gets blamed for it.
 *
 * `generic` is a superset of the column names, so falling back to it is always
 * at least as good as a specific adapter that cannot see the columns it wants.
 *
 * The choice is printed with the result either way: a reader has to be able to
 * see that the file was understood the way they meant it.
 */
export function detectAdapter(rows: Row[]): AdapterDefinition {
  const sample = rows.slice(0, 50);
  const keys = new Set<string>();
  for (const row of sample) for (const key of Object.keys(row)) keys.add(key);

  let best = generic;
  let bestScore = 0;
  for (const adapter of ADAPTERS) {
    if (adapter.fingerprint.length === 0) continue;
    const score = adapter.fingerprint.filter((key) => keys.has(key)).length;
    if (score > bestScore) {
      best = adapter;
      bestScore = score;
    }
  }

  if (best === generic) return generic;

  // Can it see a timestamp, a model, and a figure of some kind? If not, the
  // fingerprint matched a column this file happens to share and nothing else.
  const readable = sample.some((row) => {
    const hasTime = first(row, best.timestamp) !== undefined;
    const hasModel = toText(first(row, best.model)).trim() !== "";
    const hasFigure =
      first(row, best.cost) !== undefined ||
      first(row, best.inputTokens) !== undefined ||
      first(row, best.outputTokens) !== undefined;
    return hasTime && hasModel && hasFigure;
  });

  return readable ? best : generic;
}

/** Read a possibly-dotted path out of a row. */
function pick(row: Row, path: string): unknown {
  if (!path.includes(".")) return row[path];
  let current: unknown = row;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function first(row: Row, paths: string[]): unknown {
  for (const path of paths) {
    const value = pick(row, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function toText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function toInteger(value: unknown): number | null {
  const text = toText(value).trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/**
 * Parse a timestamp the way exporters actually write them.
 *
 * ISO 8601 covers nearly everything. Unix seconds and milliseconds appear in
 * raw logs, and are told apart by magnitude — the boundary is far from any
 * plausible date in either reading, so it cannot silently pick wrong.
 *
 * A bare `YYYY-MM-DD HH:MM:SS` with no zone is read as UTC, because that is
 * what a Postgres `timestamp` column dumps and what LiteLLM stores. Reading it
 * as local time would shift every row by the operator's offset and produce a
 * variance made of time zones. The README says so.
 */
export function parseTimestamp(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const text = toText(value).trim();
  if (!text) return null;

  if (/^\d+(\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    // Seconds until the year 5138; milliseconds after. Nothing real is close.
    const ms = numeric > 100_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // No zone marker at all: treat as UTC rather than as the local calendar.
  const zoneless = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(text);
  const normalised = zoneless ? `${text.replace(" ", "T")}Z`.replace("ZZ", "Z") : text;

  const date = new Date(normalised);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface ParseResult {
  rows: UsageRow[];
  /** Rows dropped because they carried no usable timestamp or model. */
  malformed: number;
  /** The first few reasons, so a broken file says what is wrong with it. */
  malformedExamples: string[];
}

export function parseRows(rows: Row[], adapter: AdapterDefinition): ParseResult {
  const parsed: UsageRow[] = [];
  const examples: string[] = [];
  let malformed = 0;

  rows.forEach((row, index) => {
    const at = parseTimestamp(first(row, adapter.timestamp));
    if (!at) {
      malformed += 1;
      if (examples.length < 3) {
        examples.push(
          `row ${index + 2}: no usable timestamp (looked for ${adapter.timestamp.slice(0, 3).join(", ")})`,
        );
      }
      return;
    }

    const model = toText(first(row, adapter.model)).trim();
    if (!model) {
      malformed += 1;
      if (examples.length < 3) {
        examples.push(`row ${index + 2}: no model (looked for ${adapter.model.slice(0, 3).join(", ")})`);
      }
      return;
    }

    const rawCost = first(row, adapter.cost);
    const micros = rawCost === undefined ? null : usdDecimalToMicros(toText(rawCost));

    parsed.push({
      at,
      model,
      micros,
      inputTokens: toInteger(first(row, adapter.inputTokens)),
      outputTokens: toInteger(first(row, adapter.outputTokens)),
      provider: toText(first(row, adapter.provider)).trim() || null,
      zeroCost: micros === 0n,
    });
  });

  return { rows: parsed, malformed, malformedExamples: examples };
}
