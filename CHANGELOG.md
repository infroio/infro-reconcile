# Changelog

## 0.1.2

- Correct the runtime version reported by the CLI and provider user agents and
  enforce the package version in tests.

## 0.1.1

- Link the package metadata to its public GitHub repository and issue tracker.
- Make the test command portable across supported operating systems.

## 0.1.0

First release.

- `infro-reconcile openai` and `infro-reconcile anthropic` pull the provider's
  own cost report for a window of complete UTC days and print it per day.
- `--usage <file>` compares it against a usage export — CSV, JSONL or JSON —
  needing only a timestamp, a model, and either a cost or a token count.
  Adapters for LiteLLM's spend log and Langfuse's observations export are
  recognised from their columns; anything else reads through the documented
  generic contract.
- Per-day variance table, a summary with its own caveats, `--json` with every
  amount as an exact string, and `--fail-over <percent>` for CI.
- Credentials are read from `OPENAI_ADMIN_KEY` / `ANTHROPIC_ADMIN_KEY` and from
  nothing else. A key found in the arguments stops the run. Nothing is written
  to disk.

### The units, which are the point

OpenAI reports **dollars as a JSON number**; Anthropic reports **cents as a
decimal string**. Each adapter converts at the boundary into micro-USD held as
a `bigint`, nothing else handles a provider's raw amount, and `test/money.test
.mjs` asserts the two conversions do not collapse into each other — a test
confirmed to fail when either conversion is swapped for the other. Both
endpoints were verified against the vendors' live documentation on 2026-09-20.

### What it will not do

No built-in price table, so a row with tokens and no cost is reported unpriced
rather than guessed at. A day the export covers and the provider did not report
is recorded rather than dropped. Today is never in the window. A provider with
no adapter gets no variance rather than a variance of zero.

### Notes for anyone working on it

- **Tests run against `dist/` and use `node:test`, with no test-runner
  dependency.** The three SDKs in this repo use vitest, and adding it as a
  second workspace consumer trips an arborist bug in npm 10.4 (`Cannot read
  properties of null (reading 'edgesOut')`) that breaks `npm install` for the
  whole repository. Not worth it for a runner — and testing the built artefact
  catches the class of failure where a package builds and packs perfectly while
  missing a file.
- The package is ESM-only.
- Published as `@infro.io/reconcile` with the binary `infro-reconcile`.
