# infro-reconcile

[![npm](https://img.shields.io/npm/v/%40infro.io%2Freconcile)](https://www.npmjs.com/package/@infro.io/reconcile)
[![CI](https://github.com/infroio/infro-reconcile/actions/workflows/ci.yml/badge.svg)](https://github.com/infroio/infro-reconcile/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/node/v/%40infro.io%2Freconcile)](https://www.npmjs.com/package/@infro.io/reconcile)

**Did your LLM provider bill you what your logs say they should have?**

This pulls OpenAI's or Anthropic's own cost report, compares it against a usage
export you already have, and prints the per-day variance.

```
$ infro-reconcile openai --from 2026-09-01 --to 2026-09-07 --usage spend.csv

OpenAI cost report vs spend.csv (read as a LiteLLM spend log), 2026-09-01 to 2026-09-07 UTC

UTC day     OpenAI billed  your export   variance
----------  -------------  -----------  ---------
2026-09-01      $412.8042    $402.1100  +$10.6942  +2.6%
2026-09-02      $388.1900    $377.4000  +$10.7900  +2.8%
2026-09-03      $501.5512    $488.0200  +$13.5312  +2.7%
2026-09-04      $455.0200    $441.9000  +$13.1200  +2.9%
2026-09-05      $398.4400    $389.1100   +$9.3300  +2.3%
2026-09-06              —    $120.5000          —         not reported by provider
2026-09-07      $502.9000    $489.6600  +$13.2400  +2.6%

Over 6 comparable days: OpenAI billed $2,658.9054, your export accounts for
$2,588.2000, variance +$70.7054 (+2.7%).
  Positive: OpenAI billed more than your records account for.
$120.50 of your export falls on days the provider reported nothing for. Not counted above.
Rows excluded: 1 unpriced carrying 22,000 tokens (gpt-5-mini x1); 7 for other providers (7 anthropic).
```

A steady one-way gap like that is the interesting result. A single day's
difference is nearly always timing. Five days all leaning the same way is a
rate you are not modelling — a cache-write premium, a negotiated rate nobody
entered, a price change you missed.

It is a single command with **no dependencies, no account, no signup and no
config file**. It reads two things: a provider's cost API, and a file you point
it at.

```bash
npx @infro.io/reconcile openai --usage spend.csv
```

---

## Install

```bash
npm install -g @infro.io/reconcile   # or run it with npx, above
```

Node 20 or newer.

## Credentials

Both cost endpoints need an **admin-scoped billing key**, which is a different
class of key from the one that serves inference. An ordinary API key returns
401 here, and that is the first thing most people hit.

| Provider | Variable | Key |
| --- | --- | --- |
| `openai` | `OPENAI_ADMIN_KEY` | An Admin key (`sk-admin-…`), created by an organization owner under Settings → Admin keys. |
| `anthropic` | `ANTHROPIC_ADMIN_KEY` | An Admin key (`sk-ant-admin…`), created by an organization admin in the Console under Settings. A workspace-scoped key will not work. |

```bash
export OPENAI_ADMIN_KEY=sk-admin-...
infro-reconcile openai --usage spend.csv
```

**There is no `--api-key` flag, and there will not be one.** A key found
anywhere in the arguments stops the run. Command lines are echoed by npm, kept
in shell history, printed by CI and visible in `ps` to every other user on the
machine. `--key-env NAME` reads a different variable if you have your own
convention — a name is not a secret.

**Nothing is written to disk.** No cache, no config, no credential store. The
tool reads the cost API and your file, and writes to stdout.

---

## The column contract

Your export needs three things per row. That is the whole contract:

| | | |
| --- | --- | --- |
| **a timestamp** | required | ISO 8601, or unix seconds/milliseconds. A timestamp with no zone is read as **UTC**. |
| **a model** | required | The provider's model id, e.g. `gpt-5`, `claude-opus-5`, `openai/gpt-5`. |
| **a cost**, or **a token count** | at least one | Cost in USD. A row with only tokens is reported as *unpriced* rather than guessed at — see below. |

Two optional columns earn their place:

- **a provider column** (`provider`, `custom_llm_provider`, `vendor`) — settles
  attribution outright, and is the only way to get the Bedrock and Vertex cases
  right. If it is absent, the provider is inferred from the model id.
- **token counts** alongside a cost — used only to report the size of what was
  excluded, never to price anything.

Column names are matched against a list of what real exporters actually write,
so these work with no flags:

| `--format` | Recognised by | Reads |
| --- | --- | --- |
| `litellm` | `spend`, `custom_llm_provider` | `startTime`, `model`, `spend`, `custom_llm_provider`, `prompt_tokens`, `completion_tokens` |
| `langfuse` | `calculatedTotalCost`, `cost_details`, `usage_details`, … | `startTime`/`start_time`, `model`/`provided_model_name`, `calculatedTotalCost`/`total_cost`/`cost_details.total`, `usage_details.input`/`output` |
| `generic` | anything else | `timestamp`/`time`/`date`/`created_at`/…, `model`/`model_name`/…, `cost`/`cost_usd`/`spend`/`total_cost`/…, `input_tokens`/`prompt_tokens`/…, `output_tokens`/`completion_tokens`/… |

The reader it chose is printed above the table, and it is checked before it is
used: if the detected adapter cannot see a timestamp and a model in your file,
it falls back to the generic contract rather than reporting every row as
malformed.

CSV, JSONL and JSON are all accepted, detected by extension and then by
content. The CSV reader is RFC 4180 — quoted fields, embedded commas and
newlines, doubled quotes, CRLF, and the BOM Excel writes. LiteLLM puts JSON
*inside* a CSV cell, and a naive comma split shifts every column after it and
reads a model name out of a cost column without erroring.

Rename at most three columns and anything works:

```csv
timestamp,model,cost
2026-09-01T10:00:00Z,gpt-5,0.0123
```

```bash
infro-reconcile openai --usage raw.csv
cat raw.csv | infro-reconcile openai --usage -
```

---

## The two unit gotchas

**This is the part that goes wrong, and the reason the tool exists.** The two
providers report the same quantity in different units:

| Provider | Field | Unit | `"123.45"` means |
| --- | --- | --- | --- |
| OpenAI `GET /v1/organization/costs` | `amount.value` | **dollars**, as a JSON number | $123.45 |
| Anthropic `GET /v1/organizations/cost_report` | `amount` | **cents**, as a decimal string | $1.23 |

Anthropic's documentation says so in as many words: *"All costs in USD,
reported as decimal strings in lowest units (cents)"*.

Read one as the other and every figure is a hundred times wrong. It is the kind
of error that survives review, because a variance is *supposed* to be
surprising — a number that is 100× out reads as a finding rather than as a bug.
It has shipped publicly before; there is a pull request in the wild titled *"Fix
Anthropic cost report 100x overstatement (cents parsed as dollars)"*.

So each adapter converts at the boundary into micro-USD (1e-6 USD, held as a
`bigint`), nothing else in the tool ever touches a provider's raw amount, and
there is a test asserting the two conversions do not collapse into each other.
If you are writing your own version of this, that test is the one to copy.

Money is `bigint` micro-USD throughout rather than a float, because a dollar
float cannot hold a tenth of a cent and a month of inference is a long sum of
tenths of a cent. `--json` emits every amount twice — `*_micros` as an exact
integer string and `*_usd` as an exact decimal string — and never as a JSON
number.

---

## What it refuses to do

Every one of these is a way to produce a confident, wrong, plausible number.

- **A day your export covers and the provider did not report is recorded, not
  dropped.** It is the most interesting row the table can hold: either the
  export contains requests that have not been billed, or the provider's figure
  has not settled, or those rows belong to somebody else. It shows as `—` with
  `not reported by provider`, never as a provider total of zero.

- **Today is excluded.** A part-day written into a whole-day row makes the
  variance look enormous every morning and shrink through the afternoon. Ask
  for today and the window is clamped to yesterday, and says so.

- **A provider with no adapter gets no variance, never zero.** Zero would read
  as "your records agree with your invoice", which is the strongest claim this
  tool can make, asserted about a provider nobody read. Only `openai` and
  `anthropic` have adapters.

- **Unpriced and unattributed rows are counted and named, never folded in as
  zero.** A row with tokens and no cost makes your side low by an unknown
  amount. Saying so is the difference between "your rates are wrong" and "we
  have no rate", which have different fixes.

- **There is no built-in price table.** A rate card compiled into a CLI is
  wrong the week after a vendor changes a price, and wrong *silently* — the
  variance it produces looks exactly like the finding you came for. Your rates
  are yours. Pass `--rates rates.json` and the output records that the priced
  side came from your card:

  ```json
  {
    "gpt-5":          { "input_per_1m": 1.25, "output_per_1m": 10.00 },
    "claude-opus-5":  { "input_per_1m": 5,    "output_per_1m": 25 }
  }
  ```

  A key matches a model exactly or as its longest prefix, so `claude-opus-5`
  prices `claude-opus-5-20260901` without a dated key per release.

- **A non-USD cost report is refused rather than converted.**

- **The headline percentage carries its own caveats.** A variance over two
  days, or one where a fifth of the rows had no price, is arithmetic rather
  than evidence, and the output says which before you act on it.

---

## Known limits

Read these before trusting a variance that does not close.

**Anthropic's cost endpoint excludes Priority Tier.** Their documentation:
*"Priority Tier costs use a different billing model and are not included in the
cost endpoint."* On an account that uses it, this variance is missing a term by
design.

**Anthropic's cost endpoint is unavailable for Claude on AWS.** Usage served
through Bedrock is billed by AWS and will not appear. The same goes for Vertex,
billed by Google.

**Bedrock, Vertex and Azure have no adapter.** Their cost lives in the
surrounding cloud's billing system, behind IAM that has nothing to do with an
API key. Rows attributed to them are excluded and counted, never compared.

**Provider attribution from a model id is a heuristic.** With no provider
column, the tool reads model *shape*: `anthropic.claude-…-v1:0` is Bedrock,
`claude-…@20260901` is Vertex, `claude-…` is Anthropic direct. It is right for
the ids these platforms actually emit and it is still a guess. Export a
provider column if you have one.

**Cost figures settle late.** Both providers report per UTC day and a recent
day can still move. Anthropic's data typically appears within five minutes;
OpenAI's can take longer.

**Code execution and server-side tool usage** appear in Anthropic's cost report
under descriptions like `Code Execution Usage`, and have no matching row in most
usage exports.

**Everything is UTC.** Both cost APIs bucket by UTC day; a local calendar would
shift every row by your offset and produce a variance made entirely of time
zones. A timestamp in your export with no zone is read as UTC, not as local
time.

---

## Options

```
infro-reconcile <openai | anthropic> [options]

  --from <YYYY-MM-DD>     First UTC day, inclusive.
  --to <YYYY-MM-DD>       Last UTC day, inclusive. Never today.
                          Default: the last 7 complete days.

  --usage <file>          Your usage export. CSV, JSONL or JSON. "-" reads
                          stdin. Without it, the provider's report is printed
                          and nothing is compared.
  --format <name>         Force the export reader: litellm | langfuse | generic.
  --file-format <kind>    Force csv | jsonl | json.
  --rates <file>          JSON rate card for exports carrying tokens and no cost.
  --all-rows              Do not filter by provider. Use when the file already
                          contains only this provider's requests.

  --json                  Machine-readable output. Money as exact strings.
  --fail-over <percent>   Exit 3 when the variance exceeds this, either way.
  --key-env <NAME>        Read the credential from a different variable.
  --verbose               Log each HTTP request (never the credential).
```

Exit codes: `0` ran, `1` bad usage or unreadable input, `2` the provider
refused or could not be reached, `3` the variance exceeded `--fail-over`.

### In CI

```bash
- run: npx @infro.io/reconcile anthropic --usage exports/spend.jsonl --fail-over 5
  env:
    ANTHROPIC_ADMIN_KEY: ${{ secrets.ANTHROPIC_ADMIN_KEY }}
```

### As a library

```ts
import { compare, openai, resolveWindow } from "@infro.io/reconcile";

const window = resolveWindow({ from: "2026-09-01", to: "2026-09-07" });
const costDays = await openai.fetchDays(process.env.OPENAI_ADMIN_KEY, window);
const result = compare({ provider: "openai", ...window, costDays, usage: myRows });
```

---

## Licence

MIT. Issues and questions: support@infro.io.

---

*Built by [INFRO](https://infro.io), which does this continuously across every
provider you use — but this tool stands alone and always will.*
