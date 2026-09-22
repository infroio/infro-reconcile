/**
 * The two cost adapters, driven against each vendor's own documented example
 * payload through a stubbed `fetch`.
 *
 * `test/money.test.mjs` proves the two conversions differ. These prove each
 * adapter reaches for the right one — which is the half a unit test of the
 * arithmetic alone cannot cover, because an adapter that calls the wrong
 * converter has perfectly correct arithmetic in it.
 *
 * The payloads are transcribed from the vendors' live documentation, read on
 * 2026-09-20. When one of these tests starts failing, check the docs before
 * changing the expectation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { anthropic, openai, CostApiError, formatUsd } from "../dist/index.js";

/** A `fetch` that answers from a table and records what it was asked for. */
function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const answer = handler(String(url), init);
    const body = answer.body ?? {};
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json", ...(answer.headers ?? {}) },
    });
  };
  impl.calls = calls;
  return impl;
}

const WINDOW = { from: "2026-09-01", to: "2026-09-02" };

/* ------------------------------------------------------------------ *
 * OpenAI — dollars, as a JSON number
 * ------------------------------------------------------------------ */

test("openai reads amount.value as dollars", async () => {
  const fetchImpl = stubFetch(() => ({
    body: {
      object: "page",
      data: [
        {
          object: "bucket",
          start_time: Date.UTC(2026, 8, 1) / 1000,
          end_time: Date.UTC(2026, 8, 2) / 1000,
          results: [
            {
              object: "organization.costs.result",
              amount: { value: 0.06, currency: "usd" },
              line_item: "gpt-6-astra, input_tokens",
            },
            {
              object: "organization.costs.result",
              amount: { value: 412.8, currency: "usd" },
              line_item: "gpt-6-astra, output_tokens",
            },
          ],
        },
      ],
      has_more: false,
      next_page: null,
    },
  }));

  const days = await openai.fetchDays("sk-admin-test", { ...WINDOW, fetchImpl });

  assert.equal(days.length, 1);
  assert.equal(days[0].day, "2026-09-01");
  // $0.06 + $412.80. Read as cents this would be $4.128 and change.
  assert.equal(days[0].micros, 412_860_000n);
  assert.equal(formatUsd(days[0].micros), "$412.86");
  assert.equal(days[0].lineItems.length, 2);
  assert.equal(days[0].lineItems[0].label, "gpt-6-astra, input_tokens");
});

test("openai asks for daily buckets over the right half-open range", async () => {
  const fetchImpl = stubFetch(() => ({ body: { data: [], has_more: false } }));
  await openai.fetchDays("sk-admin-test", { from: "2026-09-01", to: "2026-09-07", fetchImpl });

  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.origin + url.pathname, "https://api.openai.com/v1/organization/costs");
  assert.equal(url.searchParams.get("bucket_width"), "1d");
  // `--to` includes its own day; `end_time` excludes itself, so it is the 8th.
  assert.equal(Number(url.searchParams.get("start_time")), Date.UTC(2026, 8, 1) / 1000);
  assert.equal(Number(url.searchParams.get("end_time")), Date.UTC(2026, 8, 8) / 1000);
  assert.equal(fetchImpl.calls[0].init.headers.authorization, "Bearer sk-admin-test");
});

test("openai follows next_page until has_more is false", async () => {
  let page = 0;
  const fetchImpl = stubFetch(() => {
    page += 1;
    return {
      body: {
        data: [
          {
            start_time: Date.UTC(2026, 8, page) / 1000,
            results: [{ amount: { value: 1, currency: "usd" }, line_item: "usage" }],
          },
        ],
        has_more: page < 3,
        next_page: page < 3 ? `page_${page}` : null,
      },
    };
  });

  const days = await openai.fetchDays("sk-admin-test", { from: "2026-09-01", to: "2026-09-05", fetchImpl });
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(days.length, 3);
  assert.deepEqual(
    days.map((day) => day.day),
    ["2026-09-01", "2026-09-02", "2026-09-03"],
  );
});

/* ------------------------------------------------------------------ *
 * Anthropic — cents, as a decimal string
 * ------------------------------------------------------------------ */

test("anthropic reads amount as cents", async () => {
  const fetchImpl = stubFetch(() => ({
    body: {
      data: [
        {
          starting_at: "2026-09-01T00:00:00Z",
          ending_at: "2026-09-02T00:00:00Z",
          results: [
            {
              // Straight from Anthropic's documented example response.
              amount: "123.78912",
              currency: "USD",
              description: "Claude Opus 5 Usage - Input Tokens",
              model: "claude-opus-5",
            },
            {
              amount: "41280.000000",
              currency: "USD",
              description: "Claude Opus 5 Usage - Output Tokens",
              model: "claude-opus-5",
            },
          ],
        },
      ],
      has_more: false,
      next_page: null,
    },
  }));

  const days = await anthropic.fetchDays("sk-ant-admin-test", { ...WINDOW, fetchImpl });

  assert.equal(days.length, 1);
  // 123.78912c = $1.2378912 -> 1,237,891 micros. 41280c = $412.80.
  assert.equal(days[0].micros, 1_237_891n + 412_800_000n);
  assert.equal(formatUsd(days[0].micros), "$414.037891");

  // The assertion that matters: read as dollars this day would be $41,403.79.
  assert.ok(days[0].micros < 1_000_000_000n, "a cents figure must not be read as dollars");
});

test("anthropic sends the admin headers and an inclusive-to window", async () => {
  const fetchImpl = stubFetch(() => ({ body: { data: [], has_more: false } }));
  await anthropic.fetchDays("sk-ant-admin-test", { from: "2026-09-01", to: "2026-09-07", fetchImpl });

  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.origin + url.pathname, "https://api.anthropic.com/v1/organizations/cost_report");
  assert.equal(url.searchParams.get("starting_at"), "2026-09-01T00:00:00.000Z");
  assert.equal(url.searchParams.get("ending_at"), "2026-09-08T00:00:00.000Z");
  // 31 is the documented maximum for daily buckets, and daily is all there is.
  assert.equal(url.searchParams.get("limit"), "31");

  const headers = fetchImpl.calls[0].init.headers;
  assert.equal(headers["x-api-key"], "sk-ant-admin-test");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.ok(!("authorization" in headers), "Anthropic takes x-api-key, not a bearer token");
});

test("anthropic accepts a numeric amount defensively, still as cents", async () => {
  const fetchImpl = stubFetch(() => ({
    body: {
      data: [{ starting_at: "2026-09-01T00:00:00Z", results: [{ amount: 123.45, currency: "USD" }] }],
      has_more: false,
    },
  }));

  const days = await anthropic.fetchDays("sk-ant-admin-test", { ...WINDOW, fetchImpl });
  assert.equal(days[0].micros, 1_234_500n, "a number in that field is still cents");
});

/* ------------------------------------------------------------------ *
 * Shared behaviour
 * ------------------------------------------------------------------ */

test("both adapters identify themselves and refuse redirects", async () => {
  for (const provider of [openai, anthropic]) {
    const fetchImpl = stubFetch(() => ({ body: { data: [], has_more: false } }));
    await provider.fetchDays("k", { ...WINDOW, fetchImpl });
    const headers = fetchImpl.calls[0].init.headers;
    assert.match(headers["user-agent"], /^infro-reconcile\/0\.1\.2 /);
    // `fetch` follows redirects by default and would re-send an Admin key to
    // wherever it was pointed.
    assert.equal(fetchImpl.calls[0].init.redirect, "manual");

    const redirecting = stubFetch(() => ({ status: 302, headers: { location: "https://elsewhere.example" } }));
    await assert.rejects(
      () => provider.fetchDays("k", { ...WINDOW, fetchImpl: redirecting }),
      (error) => error instanceof CostApiError && /redirect/i.test(error.message),
    );
  }
});

test("a wrong key class is reported as permanent, so it is not retried for ever", async () => {
  for (const provider of [openai, anthropic]) {
    const fetchImpl = stubFetch(() => ({
      status: 401,
      body: { error: { message: "Invalid authentication" } },
    }));
    await assert.rejects(
      () => provider.fetchDays("sk-not-an-admin-key", { ...WINDOW, fetchImpl }),
      (error) => {
        assert.ok(error instanceof CostApiError);
        assert.equal(error.status, 401);
        assert.equal(error.permanent, true, "401 cannot be cleared by retrying");
        return true;
      },
    );
    // The commonest failure by a distance: both endpoints need an admin-scoped
    // key and everyone's first instinct is the inference key they already have.
    assert.match(provider.credentialHelp, /admin/i);
  }
});

test("each provider names the gaps a variance cannot close", () => {
  // Anthropic documents both of these; a variance on an affected account is
  // missing a term by design and the output has to be able to say so.
  const caveats = anthropic.caveats.join(" ");
  assert.match(caveats, /Priority Tier/);
  assert.match(caveats, /AWS/);
});
