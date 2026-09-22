/**
 * Reading somebody's usage export.
 *
 * The column contract is three things — a timestamp, a model, and either a
 * cost or a token count — and everything here is about the ways a real file
 * fails to be that: a JSON blob inside a CSV cell, a timestamp with no zone, a
 * cost column that is empty on some rows, camelCase against snake_case.
 *
 * The CSV case is the one worth being strict about. LiteLLM writes `metadata`
 * and `request_tags` as JSON *inside* a CSV cell, so a naive split on commas
 * shifts every column after them and the tool reads a model name out of a cost
 * column. It would not error. It would produce a confident, wrong variance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectAdapter, parseCsv, parseRows, parseTimestamp, readRows } from "../dist/index.js";

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

test("a JSON blob inside a CSV cell does not shift the columns", () => {
  const csv = [
    "startTime,model,spend,metadata,total_tokens",
    '2026-09-01T10:00:00Z,gpt-5,0.0123,"{""project"": ""a,b"", ""tags"": [""x"",""y""]}",150',
  ].join("\n");

  const rows = readRows("spend.csv", csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "gpt-5", "the model column is still the model column");
  assert.equal(rows[0].spend, "0.0123");
  assert.equal(rows[0].total_tokens, "150");
  assert.equal(rows[0].metadata, '{"project": "a,b", "tags": ["x","y"]}');
});

test("the CSV reader handles quotes, newlines, CRLF and Excel's BOM", () => {
  const csv = '﻿a,b\r\n"line\none","say ""hi"""\r\n';
  assert.deepEqual(parseCsv(csv), [
    ["a", "b"],
    ["line\none", 'say "hi"'],
  ]);

  // A file that does not end in a newline must not lose its last row, and one
  // that does must not gain an empty one.
  assert.equal(parseCsv("a,b\n1,2").length, 2);
  assert.equal(parseCsv("a,b\n1,2\n").length, 2);
  assert.equal(parseCsv("a,b\n1,2\n\n\n").length, 2);
});

/* ------------------------------------------------------------------ *
 * The two shipped adapters
 * ------------------------------------------------------------------ */

test("a LiteLLM spend log is recognised and read", () => {
  const csv = [
    "request_id,startTime,model,model_group,custom_llm_provider,spend,prompt_tokens,completion_tokens",
    "req_1,2026-09-01 10:00:00,gpt-5,chat,openai,0.0123,1000,500",
    "req_2,2026-09-01 11:00:00,claude-opus-5,chat,anthropic,0.4500,2000,900",
  ].join("\n");

  const rows = readRows("spend.csv", csv);
  const adapter = detectAdapter(rows);
  assert.equal(adapter.id, "litellm");

  const { rows: parsed, malformed } = parseRows(rows, adapter);
  assert.equal(malformed, 0);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].model, "gpt-5");
  assert.equal(parsed[0].micros, 12_300n, "$0.0123 is 12,300 micro-USD");
  assert.equal(parsed[0].provider, "openai", "LiteLLM already knows who served it");
  assert.equal(parsed[0].inputTokens, 1000);
  assert.equal(parsed[1].micros, 450_000n);
});

test("a Langfuse observations export is recognised in either spelling", () => {
  const camel = [
    { startTime: "2026-09-01T10:00:00.000Z", model: "gpt-5", calculatedTotalCost: 0.0123, promptTokens: 10 },
  ];
  const camelRows = readRows("obs.json", JSON.stringify(camel));
  assert.equal(detectAdapter(camelRows).id, "langfuse");
  assert.equal(parseRows(camelRows, detectAdapter(camelRows)).rows[0].micros, 12_300n);

  // The blob-storage export is snake_case and nests the figure.
  const snake = [
    {
      start_time: "2026-09-01T10:00:00.000Z",
      provided_model_name: "claude-opus-5",
      cost_details: { total: 0.45 },
      usage_details: { input: 2000, output: 900 },
    },
  ];
  const snakeRows = readRows("obs.jsonl", snake.map((row) => JSON.stringify(row)).join("\n"));
  const adapter = detectAdapter(snakeRows);
  assert.equal(adapter.id, "langfuse");
  const parsed = parseRows(snakeRows, adapter).rows[0];
  assert.equal(parsed.model, "claude-opus-5");
  assert.equal(parsed.micros, 450_000n, "a dotted path reaches the nested figure");
  assert.equal(parsed.inputTokens, 2000);
  assert.equal(parsed.outputTokens, 900);
});

test("a fingerprint that matches a shared column does not capture the file", () => {
  // Regression. LiteLLM and Langfuse both write `startTime`, so while it was a
  // LiteLLM fingerprint column every camelCase Langfuse export detected as
  // LiteLLM — whose cost column is `spend`, which Langfuse files do not have.
  // Nothing errored. Every row came back unpriced, which reads as a bad export.
  const langfuse = [{ startTime: "2026-09-01T10:00:00Z", model: "gpt-5", calculatedTotalCost: 1 }];
  const rows = readRows("obs.json", JSON.stringify(langfuse));
  assert.equal(detectAdapter(rows).id, "langfuse");
  assert.equal(parseRows(rows, detectAdapter(rows)).rows[0].micros, 1_000_000n);
});

test("an adapter that cannot read the file falls back to the generic contract", () => {
  // `spend` fingerprints as LiteLLM, but LiteLLM's timestamp column is
  // `startTime` and this file has `timestamp`. Reading it as LiteLLM would
  // make every row malformed. The detection checks before committing.
  const csv = ["timestamp,model,spend", "2026-09-01T10:00:00Z,gpt-5,0.25"].join("\n");
  const rows = readRows("mine.csv", csv);
  const adapter = detectAdapter(rows);
  assert.equal(adapter.id, "generic");

  const result = parseRows(rows, adapter);
  assert.equal(result.malformed, 0);
  assert.equal(result.rows[0].micros, 250_000n);
});

test("anything else falls back to the documented three-column contract", () => {
  const csv = ["timestamp,model,cost", "1788256800,gpt-5,0.25"].join("\n");
  const rows = readRows("mine.csv", csv);
  const adapter = detectAdapter(rows);
  assert.equal(adapter.id, "generic");

  const parsed = parseRows(rows, adapter).rows[0];
  assert.equal(parsed.micros, 250_000n);
  assert.equal(parsed.at.toISOString(), "2026-09-01T10:00:00.000Z");
});

/* ------------------------------------------------------------------ *
 * Timestamps
 * ------------------------------------------------------------------ */

test("a timestamp with no zone is read as UTC, not as the local calendar", () => {
  // This is what a Postgres `timestamp` column dumps and what LiteLLM stores.
  // Reading it as local time shifts every row by the operator's offset and
  // produces a variance made entirely of time zones.
  assert.equal(parseTimestamp("2026-09-01 10:00:00").toISOString(), "2026-09-01T10:00:00.000Z");
  assert.equal(parseTimestamp("2026-09-01T10:00:00").toISOString(), "2026-09-01T10:00:00.000Z");
  assert.equal(parseTimestamp("2026-09-01").toISOString(), "2026-09-01T00:00:00.000Z");

  // An explicit offset is honoured, because it was stated.
  assert.equal(parseTimestamp("2026-09-01T12:00:00+02:00").toISOString(), "2026-09-01T10:00:00.000Z");
});

test("unix seconds and milliseconds are told apart by magnitude", () => {
  assert.equal(parseTimestamp("1788256800").toISOString(), "2026-09-01T10:00:00.000Z");
  assert.equal(parseTimestamp("1788256800000").toISOString(), "2026-09-01T10:00:00.000Z");
  // The boundary is far from any plausible date in either reading.
  assert.equal(parseTimestamp(1788256800).toISOString(), "2026-09-01T10:00:00.000Z");
});

test("a row with no usable timestamp or model is reported, not silently dropped", () => {
  const csv = [
    "timestamp,model,cost",
    "2026-09-01T10:00:00Z,gpt-5,0.25",
    ",gpt-5,0.25",
    "2026-09-01T10:00:00Z,,0.25",
    "not-a-date,gpt-5,0.25",
  ].join("\n");

  const rows = readRows("mine.csv", csv);
  const result = parseRows(rows, detectAdapter(rows));
  assert.equal(result.rows.length, 1);
  assert.equal(result.malformed, 3);
  // A broken file has to say what is wrong with it, with a row number.
  assert.equal(result.malformedExamples.length, 3);
  assert.match(result.malformedExamples[0], /row 3/);
});

test("an empty cost cell is unpriced, and an explicit zero is a figure", () => {
  const csv = [
    "timestamp,model,cost,total_tokens",
    "2026-09-01T10:00:00Z,gpt-5,,1500",
    "2026-09-01T11:00:00Z,gpt-5,0,1500",
  ].join("\n");

  const rows = readRows("mine.csv", csv);
  const parsed = parseRows(rows, detectAdapter(rows)).rows;
  assert.equal(parsed[0].micros, null, "empty means no figure, which is not zero");
  assert.equal(parsed[0].zeroCost, false);
  assert.equal(parsed[1].micros, 0n);
  assert.equal(parsed[1].zeroCost, true, "flagged, because some exporters cannot tell free from unpriced");
});

test("a JSON export wrapped in an envelope is found", () => {
  const body = JSON.stringify({
    data: [{ timestamp: "2026-09-01T10:00:00Z", model: "gpt-5", cost: 1 }],
  });
  assert.equal(readRows("export.json", body).length, 1);
  assert.equal(readRows("export.json", JSON.stringify({ observations: [] })).length, 0);
});
