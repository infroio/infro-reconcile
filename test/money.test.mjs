/**
 * The unit conversions, which are the reason this tool exists.
 *
 * WHY THESE TESTS RUN AGAINST `dist/` AND ARE WRITTEN IN JAVASCRIPT
 *
 * `node --test` with no test-runner dependency at all, against the built
 * package rather than the source. Two things fall out of that, both wanted:
 * the artefact that would be published is the thing under test, and the tool
 * keeps its zero-dependency promise in its own toolchain as well as in its
 * output. (vitest would also have done — it is what the three SDKs use — but
 * adding it as a second workspace consumer trips an arborist bug in npm 10.4
 * and the whole repo's `npm install` stops working. Not worth it for a runner.)
 *
 * WHAT IS BEING ASSERTED
 *
 * OpenAI reports dollars as a JSON number. Anthropic reports cents as a
 * decimal string. Read one as the other and every figure is a hundred times
 * wrong — in a number nobody sanity-checks, because a variance is *supposed*
 * to be surprising. That mistake has shipped publicly before, which is why the
 * assertion below is written as "these two must not collapse into each other"
 * rather than as two independent conversions that happen to be right today.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  centsDecimalToMicros,
  dollarsFloatToMicros,
  formatUsd,
  microsToUsdString,
  usdDecimalToMicros,
  usdDecimals,
} from "../dist/index.js";

test("dollars and cents do not collapse into each other", () => {
  // The same wire value, read under each provider's documented unit.
  const asDollars = dollarsFloatToMicros(1.23);
  const asCents = centsDecimalToMicros("1.23");

  assert.equal(asDollars, 1_230_000n, "$1.23 is 1,230,000 micro-USD");
  assert.equal(asCents, 12_300n, "1.23 cents is 12,300 micro-USD");

  // The relationship, stated directly: this is the hundredfold error.
  assert.equal(asDollars, asCents * 100n);
  assert.notEqual(asDollars, asCents);
});

test("OpenAI's documented example: amount.value is dollars", () => {
  // From OpenAI's own Costs object example: {"value": 0.06, "currency": "usd"}
  assert.equal(dollarsFloatToMicros(0.06), 60_000n);
  assert.equal(microsToUsdString(dollarsFloatToMicros(0.06)), "0.060000");

  // And a realistic full-precision float, rounded once at the boundary.
  assert.equal(dollarsFloatToMicros(0.13080438340307526), 130_804n);
});

test("Anthropic's documented example: amount is cents", () => {
  // Anthropic's own wording: "123.45" in "USD" represents $1.23.
  assert.equal(centsDecimalToMicros("123.45"), 1_234_500n);
  // The fewest decimals that are still exact — four here, because a tenth of
  // a cent is the smallest unit this figure carries.
  assert.equal(formatUsd(centsDecimalToMicros("123.45")), "$1.2345");

  // Their example response carries five fractional digits of a cent; a micro
  // is four, so the fifth is rounded rather than truncated.
  assert.equal(centsDecimalToMicros("123.78912"), 1_237_891n);
  assert.equal(centsDecimalToMicros("123.78915"), 1_237_892n);

  // The shape that makes the error obvious when it is made: a real month.
  assert.equal(centsDecimalToMicros("41280.000000"), 412_800_000n);
  assert.equal(formatUsd(centsDecimalToMicros("41280.000000")), "$412.80");
});

test("a cents string read as dollars would be a hundredfold overstatement", () => {
  // Exactly the bug in the public pull request titled "Fix Anthropic cost
  // report 100x overstatement (cents parsed as dollars)".
  const correct = centsDecimalToMicros("41280.000000");
  const wrong = usdDecimalToMicros("41280.000000");

  assert.equal(formatUsd(correct), "$412.80");
  assert.equal(formatUsd(wrong), "$41,280.00");
  assert.equal(wrong, correct * 100n);
});

test("large cent figures keep their tail, which a float would lose", () => {
  // 17 significant digits: Number() cannot hold this exactly, and a month of
  // a large account is exactly this shape. The decimal path is exact.
  assert.equal(centsDecimalToMicros("123456789.1234"), 1_234_567_891_234n);
  assert.equal(microsToUsdString(centsDecimalToMicros("123456789.1234")), "1234567.891234");
});

test("a missing figure is null, never zero", () => {
  // Null means "no figure here", which the caller must report as unpriced.
  // Zero means "this cost nothing", which is a claim.
  for (const empty of ["", "   ", "—", "n/a", "null", "NaN"]) {
    assert.equal(centsDecimalToMicros(empty), null, `${JSON.stringify(empty)} is not a figure`);
    assert.equal(usdDecimalToMicros(empty), null);
  }
  assert.equal(usdDecimalToMicros("0"), 0n, "an explicit zero is a figure");
});

test("exponent notation survives, because JSON serialisers emit it", () => {
  // A cheap request costs a few millionths of a dollar and `JSON.stringify`
  // writes it as 5e-7. Dropping those rows would understate the export side.
  assert.equal(usdDecimalToMicros("5e-7"), 1n);
  assert.equal(usdDecimalToMicros("1.5e-6"), 2n);
  assert.equal(usdDecimalToMicros("2.5e-3"), 2_500n);
});

test("rounding is half-up on the magnitude, so signs behave", () => {
  assert.equal(usdDecimalToMicros("-0.0000005"), -1n);
  assert.equal(usdDecimalToMicros("0.0000005"), 1n);
  assert.equal(dollarsFloatToMicros(-0.0000005), -1n);
});

test("formatUsd never shows real money as zero", () => {
  // A cheap model bills tens of micro-USD. Two decimals would print $0.00
  // beside a four-figure total, which is how a reader decides a column does
  // not add up.
  assert.equal(formatUsd(24n), "$0.000024");
  assert.equal(formatUsd(10_000n), "$0.01");
  assert.equal(formatUsd(1_234_560_000n), "$1,234.56");
  assert.equal(formatUsd(-2_580_000n), "-$2.58");
  assert.equal(formatUsd(2_580_000n, { sign: true }), "+$2.58");
});

test("a set of amounts printed together share one precision, and stay exact", () => {
  // The column this produces is what a reader subtracts across, so it has to
  // align AND it has to add up. One precision, and the fewest that are exact.
  const column = [412_804_200n, 388_190_000n, 10_694_200n];
  const decimals = usdDecimals(column);
  assert.equal(decimals, 4, "a tenth of a cent is the smallest unit present");
  assert.deepEqual(
    column.map((value) => formatUsd(value, { decimals })),
    ["$412.8042", "$388.1900", "$10.6942"],
  );

  // A column of whole cents is not padded past them.
  assert.equal(usdDecimals([1_000_000n, 2_550_000n]), 2);
  assert.equal(formatUsd(2_550_000n, { decimals: usdDecimals([1_000_000n, 2_550_000n]) }), "$2.55");

  // And the exactness holds: the printed column sums to the printed total.
  const total = column.slice(0, 2).reduce((sum, value) => sum + value, 0n);
  assert.equal(formatUsd(total, { decimals }), "$800.9942");
  assert.equal(412.8042 + 388.19, 800.9942);
});

test("rounding a display precision is half-up, never truncation", () => {
  // Truncating makes a column drift in the reader's favour, which is the
  // direction nobody checks.
  assert.equal(formatUsd(1_005_000n, { decimals: 2 }), "$1.01");
  assert.equal(formatUsd(1_004_999n, { decimals: 2 }), "$1.00");
  assert.equal(formatUsd(-1_005_000n, { decimals: 2 }), "-$1.01");
  assert.equal(formatUsd(999_995_000n, { decimals: 2 }), "$1,000.00");
});

test("JSON money is an exact decimal string, never a float", () => {
  // The consumer of --json is a spreadsheet or another program that will sum
  // this. A double cannot hold a month of micro-USD exactly.
  assert.equal(microsToUsdString(412_800_000n), "412.800000");
  assert.equal(microsToUsdString(-1n), "-0.000001");
  assert.equal(microsToUsdString(0n), "0.000000");
});
