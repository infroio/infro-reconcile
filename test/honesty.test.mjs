/**
 * The constraints that are the point of the tool rather than features of it.
 *
 * Each of these is a way a reconciliation can produce a confident, wrong,
 * plausible number. They are tested as hard as the arithmetic, because a tool
 * that quietly drops the rows it cannot explain is worse than no tool: it
 * produces a variance that looks clean and is not.
 *
 *   1. A day the export covers and the provider did not report is RECORDED.
 *   2. Today is excluded from the window.
 *   3. A provider with no adapter gets NO variance, never zero.
 *   4. Unpriced and unattributed rows are counted and named, never folded in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { compare, providerFor, PROVIDER_IDS, resolveWindow, WindowError } from "../dist/index.js";

const day = (value) => new Date(`${value}T12:00:00Z`);

/** One usage row with a cost, attributed by its model name. */
const priced = (at, model, micros) => ({
  at: day(at),
  model,
  micros,
  inputTokens: 100,
  outputTokens: 50,
  provider: null,
  zeroCost: micros === 0n,
});

/** One usage row with tokens and no cost. */
const unpriced = (at, model) => ({
  at: day(at),
  model,
  micros: null,
  inputTokens: 1000,
  outputTokens: 500,
  provider: null,
  zeroCost: false,
});

const costDay = (value, micros) => ({ day: value, micros, currency: "usd", lineItems: [] });

/* ------------------------------------------------------------------ *
 * 1. The day the provider did not report
 * ------------------------------------------------------------------ */

test("a day the export covers and the provider did not report is recorded, not dropped", () => {
  const result = compare({
    provider: "openai",
    from: "2026-09-01",
    to: "2026-09-03",
    costDays: [costDay("2026-09-01", 100_000_000n), costDay("2026-09-03", 100_000_000n)],
    usage: [
      priced("2026-09-01", "gpt-5", 100_000_000n),
      priced("2026-09-02", "gpt-5", 50_000_000n),
      priced("2026-09-03", "gpt-5", 100_000_000n),
    ],
  });

  const second = result.days.find((row) => row.day === "2026-09-02");
  assert.ok(second, "the day must appear in the table at all");
  assert.equal(second.status, "not-reported");
  assert.equal(second.reportedMicros, null, "not reported is null, never a provider total of zero");
  assert.equal(second.usageMicros, 50_000_000n);

  // It is kept out of the headline so the percentage is not made of it, and
  // reported separately so the two figures still reconcile.
  assert.equal(result.comparedDays, 2);
  assert.equal(result.reportedMicros, 200_000_000n);
  assert.equal(result.usageMicros, 200_000_000n);
  assert.equal(result.differenceMicros, 0n);
  assert.equal(result.usageNotReportedMicros, 50_000_000n);
});

test("a day the export never reached is shown but not compared", () => {
  // The provider billed on the 1st; the export starts on the 2nd. The export
  // is not claiming zero for the 1st, it simply is not present — and treating
  // silence as a zero turns a short export into a 100% variance.
  const result = compare({
    provider: "openai",
    from: "2026-09-01",
    to: "2026-09-02",
    costDays: [costDay("2026-09-01", 400_000_000n), costDay("2026-09-02", 100_000_000n)],
    usage: [priced("2026-09-02", "gpt-5", 100_000_000n)],
  });

  const first = result.days.find((row) => row.day === "2026-09-01");
  assert.equal(first.status, "outside-export");
  assert.equal(first.usageMicros, null);
  assert.equal(result.comparedDays, 1);
  assert.equal(result.reportedOutsideExportMicros, 400_000_000n);
  // The headline is over the comparable day only, so it is 0% and not 80%.
  assert.equal(result.rate, 0);
});

test("a silent day inside the export's coverage is a real zero and is compared", () => {
  // Different from the case above: the file spans this day and has no rows
  // for it, which is a genuine claim that nothing was spent.
  const result = compare({
    provider: "openai",
    from: "2026-09-01",
    to: "2026-09-03",
    costDays: [costDay("2026-09-02", 25_000_000n)],
    usage: [priced("2026-09-01", "gpt-5", 10_000_000n), priced("2026-09-03", "gpt-5", 10_000_000n)],
  });

  const middle = result.days.find((row) => row.day === "2026-09-02");
  assert.equal(middle.status, "compared");
  assert.equal(middle.usageMicros, 0n);
  assert.equal(middle.rows, 0);
});

/* ------------------------------------------------------------------ *
 * 2. Today is excluded
 * ------------------------------------------------------------------ */

test("today is never in the window", () => {
  const now = new Date("2026-09-20T13:45:00Z");

  const asked = resolveWindow({ from: "2026-09-14", to: "2026-09-20", now });
  assert.equal(asked.to, "2026-09-19", "the window ends yesterday");
  assert.equal(asked.clampedFrom, "2026-09-20", "and says what it cut back");
  assert.ok(!asked.days.includes("2026-09-20"));

  // A future date is clamped the same way rather than being asked for.
  assert.equal(resolveWindow({ to: "2026-12-01", now }).to, "2026-09-19");
});

test("the default window is the last seven complete days", () => {
  const now = new Date("2026-09-20T00:00:01Z");
  const window = resolveWindow({ now });

  assert.equal(window.from, "2026-09-13");
  assert.equal(window.to, "2026-09-19");
  assert.equal(window.days.length, 7);
  assert.equal(window.defaulted, true);
  assert.equal(window.clampedFrom, null);
});

test("a window containing only today is refused, and says why", () => {
  const now = new Date("2026-09-20T13:45:00Z");
  assert.throws(
    () => resolveWindow({ from: "2026-09-20", to: "2026-09-20", now }),
    (error) => {
      assert.ok(error instanceof WindowError);
      // Refusing without the reason would read as a bug in the date parsing.
      assert.match(error.message, /part-day/);
      return true;
    },
  );
});

test("dates are UTC and ISO, never guessed", () => {
  // 09/01/2026 is September to an American and January to everyone else, and a
  // tool whose whole output is a date range must not pick one silently.
  assert.throws(() => resolveWindow({ from: "09/01/2026" }), WindowError);
  assert.throws(() => resolveWindow({ from: "2026-02-30" }), WindowError);
  assert.throws(() => resolveWindow({ from: "yesterday" }), WindowError);
});

/* ------------------------------------------------------------------ *
 * 3. A provider with no adapter
 * ------------------------------------------------------------------ */

test("a provider with no adapter has no variance rather than a variance of zero", () => {
  // Zero would read as "your records agree with your invoice", which is the
  // strongest claim this tool can make, asserted about a provider nobody read.
  for (const id of ["bedrock", "vertex", "azure", "gemini", "groq", ""]) {
    assert.equal(providerFor(id), null, `${id || "(empty)"} must not resolve`);
  }
  assert.deepEqual(PROVIDER_IDS, ["openai", "anthropic"]);
  assert.ok(providerFor("openai"));
  assert.ok(providerFor("OpenAI"), "the subcommand is case-insensitive");
});

/* ------------------------------------------------------------------ *
 * 4. Unpriced, unattributed and other-vendor rows
 * ------------------------------------------------------------------ */

test("rows with tokens and no cost are counted and named, never folded in as zero", () => {
  const result = compare({
    provider: "openai",
    from: "2026-09-01",
    to: "2026-09-01",
    costDays: [costDay("2026-09-01", 100_000_000n)],
    usage: [priced("2026-09-01", "gpt-5", 60_000_000n), unpriced("2026-09-01", "gpt-5-mini")],
  });

  const row = result.days[0];
  assert.equal(row.rows, 2, "both rows are counted against the day");
  assert.equal(row.pricedRows, 1, "only one of them carried a figure");
  assert.equal(row.usageMicros, 60_000_000n, "the unpriced row contributes nothing, not zero dollars");

  assert.equal(result.excluded.unpriced, 1);
  assert.equal(result.excluded.unpricedModels.get("gpt-5-mini"), 1);
  // The size of the gap is reported, so it is a known unknown.
  assert.equal(result.excluded.unpricedInputTokens, 1000);
  assert.equal(result.excluded.unpricedOutputTokens, 500);
});

test("another provider's rows are excluded and named, never compared", () => {
  // The failure this prevents: comparing a mixed log against one invoice, and
  // reporting the other providers as a large confident variance.
  const result = compare({
    provider: "openai",
    from: "2026-09-01",
    to: "2026-09-01",
    costDays: [costDay("2026-09-01", 100_000_000n)],
    usage: [
      priced("2026-09-01", "gpt-5", 100_000_000n),
      priced("2026-09-01", "claude-opus-5", 900_000_000n),
    ],
  });

  assert.equal(result.usageMicros, 100_000_000n);
  assert.equal(result.differenceMicros, 0n);
  const other = [...result.excluded.otherVendor.values()].reduce((a, b) => a + b, 0);
  assert.equal(other, 1);
});

test("Claude billed by AWS is not counted against Anthropic's invoice", () => {
  // Anthropic's cost endpoint is explicitly unavailable for Claude on AWS, so
  // a Bedrock row on the export side is a variance with no possible match.
  const result = compare({
    provider: "anthropic",
    from: "2026-09-01",
    to: "2026-09-01",
    costDays: [costDay("2026-09-01", 100_000_000n)],
    usage: [
      priced("2026-09-01", "claude-opus-5", 100_000_000n),
      { ...priced("2026-09-01", "anthropic.claude-opus-5-v1:0", 500_000_000n) },
      { ...priced("2026-09-01", "claude-opus-5@20260901", 500_000_000n) },
    ],
  });

  assert.equal(result.usageMicros, 100_000_000n);
  const reasons = [...result.excluded.otherVendor.keys()].join(" ");
  assert.match(reasons, /Bedrock/);
  assert.match(reasons, /Vertex/);
});

test("a row nobody can attribute is excluded and said out loud", () => {
  const result = compare({
    provider: "openai",
    from: "2026-09-01",
    to: "2026-09-01",
    costDays: [costDay("2026-09-01", 100_000_000n)],
    usage: [priced("2026-09-01", "our-internal-router-v2", 999_000_000n)],
  });

  assert.equal(result.usageMicros, 0n);
  assert.equal(result.excluded.unattributed, 1);
  assert.match(result.excluded.unattributedExamples.join(" "), /our-internal-router-v2/);

  // --all-rows is the escape hatch when the file is already one provider's.
  const forced = compare({
    provider: "openai",
    from: "2026-09-01",
    to: "2026-09-01",
    costDays: [costDay("2026-09-01", 100_000_000n)],
    usage: [priced("2026-09-01", "our-internal-router-v2", 999_000_000n)],
    allRows: true,
  });
  assert.equal(forced.usageMicros, 999_000_000n);
  assert.equal(forced.excluded.unattributed, 0);
});

test("an explicit provider column beats the model name", () => {
  // The exporter knows things a model id cannot carry. LiteLLM writes this.
  const result = compare({
    provider: "openai",
    from: "2026-09-01",
    to: "2026-09-01",
    costDays: [costDay("2026-09-01", 100_000_000n)],
    usage: [
      { ...priced("2026-09-01", "gpt-5", 100_000_000n), provider: "azure" },
      { ...priced("2026-09-01", "some-private-deployment", 40_000_000n), provider: "openai" },
    ],
  });

  // The Azure-served GPT row is billed by Microsoft, not by OpenAI.
  assert.equal(result.usageMicros, 40_000_000n);
  assert.equal(result.excluded.otherVendor.get("azure"), 1);
});

test("the headline percentage carries its own caveats", async () => {
  const { confidenceNotes } = await import("../dist/index.js");

  const thin = compare({
    provider: "openai",
    from: "2026-09-01",
    to: "2026-09-01",
    costDays: [costDay("2026-09-01", 100_000_000n)],
    usage: [priced("2026-09-01", "gpt-5", 90_000_000n), unpriced("2026-09-01", "gpt-5-mini")],
  });

  const notes = confidenceNotes(thin).join(" ");
  assert.match(notes, /Only 1 day/, "one day of gap is timing, not drift");
  assert.match(notes, /no cost/, "and the export side is low by an unknown amount");

  const nothing = compare({
    provider: "openai",
    from: "2026-09-01",
    to: "2026-09-01",
    costDays: [],
    usage: [],
  });
  assert.equal(nothing.rate, null, "no bill is not the same as a bill matched exactly");
  assert.match(confidenceNotes(nothing).join(" "), /No day had figures from both sides/);
});
