/**
 * The command line, driven in-process through `run()`.
 *
 * The credential rules are the part worth testing hardest. A secret on a
 * command line is echoed by npm, kept in shell history, printed by CI and
 * visible in `ps` to every other user on the machine — and that exact mistake
 * has leaked a production password on this project before. So there is no
 * `--api-key`, and a key found anywhere in argv stops the run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../dist/index.js";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_PROVIDER = 2;
const EXIT_THRESHOLD = 3;

/** Collect stdout and stderr instead of printing them. */
function capture() {
  const out = [];
  const err = [];
  return {
    out: (line = "") => out.push(String(line)),
    err: (line = "") => err.push(String(line)),
    get stdout() {
      return out.join("\n");
    },
    get stderr() {
      return err.join("\n");
    },
  };
}

function withEnv(vars, body) {
  const before = { ...process.env };
  Object.assign(process.env, vars);
  return Promise.resolve(body()).finally(() => {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  });
}

const dir = mkdtempSync(join(tmpdir(), "infro-reconcile-"));
function fixture(name, contents) {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

/* ------------------------------------------------------------------ *
 * Credentials
 * ------------------------------------------------------------------ */

test("a key on the command line is refused, not read", async () => {
  const io = capture();
  const code = await run(["openai", "--key-env", "sk-admin-abcdefghijklmnopqrstuvwxyz"], io.out, io.err);

  assert.equal(code, EXIT_USAGE);
  assert.match(io.stderr, /will not read one there/);
  // And it says the key is already compromised, because it is: it has been
  // recorded wherever this command was typed.
  assert.match(io.stderr, /Rotate that key/);
  assert.doesNotMatch(io.stdout, /sk-admin/, "and never echoes it back");
});

test("a missing credential names the variable and the key class", async () => {
  const io = capture();
  const code = await withEnv({ OPENAI_ADMIN_KEY: "" }, () => run(["openai"], io.out, io.err));

  assert.equal(code, EXIT_USAGE);
  assert.match(io.stderr, /OPENAI_ADMIN_KEY is not set/);
  assert.match(io.stderr, /sk-admin-/, "the shape of the right key");
  assert.match(io.stderr, /no flag for it/, "and why there is no flag");
});

test("--key-env names a variable, which is a name and not a secret", async () => {
  const io = capture();
  const code = await withEnv({ BILLING_KEY: "" }, () =>
    run(["anthropic", "--key-env", "BILLING_KEY"], io.out, io.err),
  );
  assert.equal(code, EXIT_USAGE);
  assert.match(io.stderr, /BILLING_KEY is not set/);
});

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

test("a provider with no adapter is refused, with the reason", async () => {
  const io = capture();
  const code = await run(["bedrock"], io.out, io.err);

  assert.equal(code, EXIT_USAGE);
  assert.match(io.stderr, /No cost adapter for "bedrock"/);
  // The sentence that stops somebody adding a zero-variance fallback later.
  assert.match(io.stderr, /variance of zero/);
  assert.doesNotMatch(io.stdout, /0\.0%/);
});

test("--help and --version answer without touching the network", async () => {
  const io = capture();
  assert.equal(await run(["--help"], io.out, io.err), EXIT_OK);
  assert.match(io.stdout, /infro-reconcile/);
  assert.match(io.stdout, /Read from the environment, never from a flag/);

  const version = capture();
  assert.equal(await run(["--version"], version.out, version.err), EXIT_OK);
  assert.equal(version.stdout.trim(), "0.1.2");
});

test("an unknown option is refused rather than ignored", async () => {
  const io = capture();
  assert.equal(await run(["openai", "--totals-only"], io.out, io.err), EXIT_USAGE);
  assert.match(io.stderr, /Unknown option --totals-only/);
});

/* ------------------------------------------------------------------ *
 * End to end, against a stubbed provider
 * ------------------------------------------------------------------ */

/**
 * Answer the OpenAI costs endpoint with a fixed set of daily totals.
 *
 * `globalThis.fetch` is replaced rather than injected, because the point of
 * this test is the path the real command takes.
 */
function stubOpenAi(dailyUsd) {
  const real = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: Object.entries(dailyUsd).map(([day, value]) => ({
          start_time: Date.parse(`${day}T00:00:00Z`) / 1000,
          results: [{ amount: { value, currency: "usd" }, line_item: "gpt-5, input_tokens" }],
        })),
        has_more: false,
        next_page: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  return () => {
    globalThis.fetch = real;
  };
}

const USAGE_CSV = [
  "timestamp,model,cost",
  "2026-09-01T10:00:00Z,gpt-5,10.00",
  "2026-09-02T10:00:00Z,gpt-5,20.00",
].join("\n");

test("a clean reconciliation prints the table, the totals and the caveats", async () => {
  const restore = stubOpenAi({ "2026-09-01": 10, "2026-09-02": 20 });
  try {
    const io = capture();
    const code = await withEnv({ OPENAI_ADMIN_KEY: "sk-admin-test" }, () =>
      run(
        ["openai", "--from", "2026-09-01", "--to", "2026-09-02", "--usage", fixture("u.csv", USAGE_CSV)],
        io.out,
        io.err,
      ),
    );

    assert.equal(code, EXIT_OK);
    assert.match(io.stdout, /2026-09-01/);
    assert.match(io.stdout, /\$30\.00/, "both sides total thirty dollars");
    assert.match(io.stdout, /The two agree exactly/);
    // The provider's documented gaps are printed with the result, always.
    assert.match(io.stdout, /Known gaps in OpenAI's cost endpoint/);
  } finally {
    restore();
  }
});

test("--json emits money as exact strings and never as a float", async () => {
  const restore = stubOpenAi({ "2026-09-01": 10, "2026-09-02": 25 });
  try {
    const io = capture();
    const code = await withEnv({ OPENAI_ADMIN_KEY: "sk-admin-test" }, () =>
      run(
        [
          "openai",
          "--from",
          "2026-09-01",
          "--to",
          "2026-09-02",
          "--usage",
          fixture("u2.csv", USAGE_CSV),
          "--json",
        ],
        io.out,
        io.err,
      ),
    );

    assert.equal(code, EXIT_OK);
    const report = JSON.parse(io.stdout);

    assert.equal(report.tool, "infro-reconcile");
    assert.equal(report.provider, "openai");
    assert.equal(report.window.timezone, "UTC");
    assert.equal(report.summary.compared_days, 2);
    // $35 billed against $30 recorded.
    assert.equal(report.summary.reported_usd, "35.000000");
    assert.equal(report.summary.usage_usd, "30.000000");
    assert.equal(report.summary.difference_usd, "5.000000");
    assert.equal(typeof report.summary.reported_micros, "string");
    assert.ok(Math.abs(report.summary.variance_rate - 5 / 35) < 1e-12);
    // Positive means the provider billed more than the export accounts for.
    assert.ok(report.summary.variance_rate > 0);
    assert.ok(Array.isArray(report.provider_caveats));
  } finally {
    restore();
  }
});

test("--fail-over exits non-zero on a large variance, for CI", async () => {
  const restore = stubOpenAi({ "2026-09-01": 10, "2026-09-02": 40 });
  try {
    const io = capture();
    const code = await withEnv({ OPENAI_ADMIN_KEY: "sk-admin-test" }, () =>
      run(
        [
          "openai",
          "--from=2026-09-01",
          "--to=2026-09-02",
          `--usage=${fixture("u3.csv", USAGE_CSV)}`,
          "--fail-over=5",
        ],
        io.out,
        io.err,
      ),
    );

    // $50 billed against $30 recorded is 40% out.
    assert.equal(code, EXIT_THRESHOLD);
    assert.match(io.stderr, /exceeds the --fail-over threshold/);
  } finally {
    restore();
  }
});

test("with no usage export, the provider's own figures are printed and nothing is compared", async () => {
  const restore = stubOpenAi({ "2026-09-01": 10, "2026-09-02": 20 });
  try {
    const io = capture();
    const code = await withEnv({ OPENAI_ADMIN_KEY: "sk-admin-test" }, () =>
      run(["openai", "--from", "2026-09-01", "--to", "2026-09-02"], io.out, io.err),
    );

    assert.equal(code, EXIT_OK);
    assert.match(io.stdout, /\$30\.00/);
    assert.match(io.stdout, /nothing was compared/);
    assert.doesNotMatch(io.stdout, /variance/i);
  } finally {
    restore();
  }
});

test("a provider that refuses is reported as the provider's refusal", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "Invalid authentication" } }), { status: 401 });
  try {
    const io = capture();
    const code = await withEnv({ OPENAI_ADMIN_KEY: "sk-not-admin" }, () =>
      run(["openai", "--from", "2026-09-01", "--to", "2026-09-02"], io.out, io.err),
    );

    assert.equal(code, EXIT_PROVIDER);
    assert.match(io.stderr, /OpenAI refused the request/);
    // A 401 is nearly always the wrong key class, so the help follows it.
    assert.match(io.stderr, /Admin key/);
  } finally {
    globalThis.fetch = real;
  }
});

test("a non-USD report is refused rather than converted", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            start_time: Date.parse("2026-09-01T00:00:00Z") / 1000,
            results: [{ amount: { value: 10, currency: "eur" }, line_item: "usage" }],
          },
        ],
        has_more: false,
      }),
      { status: 200 },
    );
  try {
    const io = capture();
    const code = await withEnv({ OPENAI_ADMIN_KEY: "sk-admin-test" }, () =>
      run(["openai", "--from", "2026-09-01", "--to", "2026-09-02"], io.out, io.err),
    );

    assert.equal(code, EXIT_PROVIDER);
    assert.match(io.stderr, /EUR, not USD/);
  } finally {
    globalThis.fetch = real;
  }
});

test("asking for today says so on stderr rather than quietly returning less", async () => {
  const restore = stubOpenAi({});
  try {
    const io = capture();
    const today = new Date().toISOString().slice(0, 10);
    await withEnv({ OPENAI_ADMIN_KEY: "sk-admin-test" }, () =>
      run(["openai", "--to", today], io.out, io.err),
    );
    assert.match(io.stderr, /includes today or later/);
    assert.match(io.stderr, /part-day/);
  } finally {
    restore();
  }
});
