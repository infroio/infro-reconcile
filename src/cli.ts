#!/usr/bin/env node
/**
 * The command line.
 *
 * CREDENTIALS COME FROM THE ENVIRONMENT AND NOTHING ELSE.
 *
 * There is no `--api-key`, and a key found anywhere in `argv` stops the run
 * with an explanation. This is not fastidiousness: `npm` echoes the script it
 * runs, shells keep history, CI prints its own command lines, and a secret
 * passed as an argument is visible in `ps` to every other user on the machine.
 * That exact mistake has leaked a production password on this project before.
 *
 * `--key-env` names a *variable*, which is a name and not a secret, so an
 * existing convention does not force anybody into the unsafe shape.
 *
 * NOTHING IS WRITTEN TO DISK. No cache, no config file, no credential store.
 * The tool reads two things — a provider's cost API and a file you point it at
 * — and writes to stdout.
 */

import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { compare } from "./compare.js";
import { formatRate } from "./money.js";
import { PROVIDER_IDS, providerFor, CostApiError } from "./providers/index.js";
import { renderJson, renderReportOnly, renderSummary, renderTable } from "./render.js";
import {
  ADAPTERS,
  adapterFor,
  detectAdapter,
  parseRows,
  type AdapterDefinition,
} from "./usage/adapters.js";
import { readRows, UsageFileError, type UsageFormat } from "./usage/read.js";
import { parseRateCard } from "./usage/rates.js";
import type { Vendor } from "./usage/vendor.js";
import { VERSION } from "./version.js";
import { resolveWindow, WindowError } from "./window.js";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_PROVIDER = 2;
const EXIT_THRESHOLD = 3;

class UsageError extends Error {}

/** Anything that looks like a live key, so it can be refused rather than used. */
const KEY_SHAPED = /\b(sk-[A-Za-z0-9_-]{16,}|sk_[A-Za-z0-9_-]{16,})\b/;

const HELP = `infro-reconcile ${VERSION}

  Pull a provider's own cost report, compare it to your usage export, and print
  the variance. Works standalone: LiteLLM, Langfuse, or any CSV/JSONL with a
  timestamp, a model and a cost.

USAGE

  infro-reconcile <provider> [options]

  <provider>              ${PROVIDER_IDS.join(" | ")}

OPTIONS

  --from <YYYY-MM-DD>     First UTC day, inclusive.
  --to <YYYY-MM-DD>       Last UTC day, inclusive. Never today: a part-day
                          cannot be compared against a whole one.
                          Default: the last 7 complete days.

  --usage <file>          Your usage export. CSV, JSONL or JSON. "-" reads
                          stdin. Without it, the provider's report is printed
                          and nothing is compared.
  --format <name>         Force the export reader: ${ADAPTERS.map((a) => a.id).join(" | ")}.
                          Detected from the file's columns otherwise.
  --file-format <kind>    Force csv | jsonl | json. Detected otherwise.
  --rates <file>          JSON rate card, for exports that carry tokens and no
                          cost. Without one, those rows are reported unpriced
                          rather than guessed at.
  --all-rows              Do not filter the export by provider. Use when the
                          file already contains only this provider's requests.

  --json                  Machine-readable output. Money as exact strings.
  --fail-over <percent>   Exit ${EXIT_THRESHOLD} when the variance exceeds this, either way.
                          For CI.
  --verbose               Log each HTTP request (never the credential).
  --version, --help

CREDENTIALS

  Read from the environment, never from a flag:

    OPENAI_ADMIN_KEY      an OpenAI Admin key      (starts sk-admin-)
    ANTHROPIC_ADMIN_KEY   an Anthropic Admin key   (starts sk-ant-admin)

  Both are admin-scoped billing keys, which are a different class from the key
  that serves inference. Use --key-env <NAME> to read a different variable.

EXAMPLES

  infro-reconcile openai --from 2026-09-01 --to 2026-09-15 --usage spend.csv
  infro-reconcile anthropic --usage observations.jsonl --json
  infro-reconcile openai --usage - < spend.csv

  Days, amounts and windows are UTC throughout.
`;

interface Options {
  provider: string;
  from?: string;
  to?: string;
  usage?: string;
  format?: string;
  fileFormat?: UsageFormat;
  rates?: string;
  allRows: boolean;
  json: boolean;
  failOver?: number;
  verbose: boolean;
  keyEnv?: string;
}

const FLAGS_WITH_VALUES = new Set([
  "--from",
  "--to",
  "--usage",
  "--format",
  "--file-format",
  "--rates",
  "--fail-over",
  "--key-env",
]);

function parseArgs(argv: string[]): Options | "help" | "version" {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return "help";
  if (argv.includes("--version") || argv.includes("-V")) return "version";

  // Before anything else: refuse a secret on the command line. Reading it
  // would work, and that is the problem — it would teach the habit.
  for (const argument of argv) {
    if (KEY_SHAPED.test(argument)) {
      throw new UsageError(
        "That looks like an API key on the command line, and this tool will not read one there.\n" +
          "Command lines are echoed by npm, kept in shell history, printed by CI, and visible in `ps`.\n\n" +
          "  export OPENAI_ADMIN_KEY=...      # then run without the flag\n\n" +
          "Rotate that key: it has already been recorded wherever this command was typed.",
      );
    }
  }

  const options: Options = { provider: "", allRows: false, json: false, verbose: false };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i] ?? "";

    if (!argument.startsWith("-")) {
      positional.push(argument);
      continue;
    }

    // `--flag=value` as readily as `--flag value`.
    let flag = argument;
    let inline: string | null = null;
    const equals = argument.indexOf("=");
    if (equals > 0) {
      flag = argument.slice(0, equals);
      inline = argument.slice(equals + 1);
    }

    const takeValue = (): string => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        throw new UsageError(`${flag} needs a value.`);
      }
      i += 1;
      return next;
    };

    if (FLAGS_WITH_VALUES.has(flag)) {
      const value = takeValue();
      switch (flag) {
        case "--from":
          options.from = value;
          break;
        case "--to":
          options.to = value;
          break;
        case "--usage":
          options.usage = value;
          break;
        case "--format":
          options.format = value;
          break;
        case "--file-format":
          if (value !== "csv" && value !== "jsonl" && value !== "json") {
            throw new UsageError(`--file-format must be csv, jsonl or json, not "${value}".`);
          }
          options.fileFormat = value;
          break;
        case "--rates":
          options.rates = value;
          break;
        case "--key-env":
          options.keyEnv = value;
          break;
        case "--fail-over": {
          const percent = Number(value);
          if (!Number.isFinite(percent) || percent < 0) {
            throw new UsageError(`--fail-over needs a non-negative percentage, not "${value}".`);
          }
          options.failOver = percent;
          break;
        }
      }
      continue;
    }

    switch (flag) {
      case "--all-rows":
        options.allRows = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      default:
        throw new UsageError(`Unknown option ${flag}. Run with --help.`);
    }
  }

  if (positional.length === 0) {
    throw new UsageError(`Name a provider: ${PROVIDER_IDS.join(" or ")}. Run with --help.`);
  }
  if (positional.length > 1) {
    throw new UsageError(`Unexpected argument "${positional[1]}". One provider at a time.`);
  }
  options.provider = positional[0] ?? "";

  return options;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    throw new UsageFileError("Could not read the usage export from stdin.");
  }
}

function readFileOrStdin(path: string): string {
  if (path === "-") return readStdin();
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : (error as Error).message;
    throw new UsageFileError(`Could not read ${path}: ${reason}`);
  }
}

export async function run(argv: string[], out = console.log, err = console.error): Promise<number> {
  let options: Options | "help" | "version";
  try {
    options = parseArgs(argv);
  } catch (error) {
    err(`${(error as Error).message}`);
    return EXIT_USAGE;
  }

  if (options === "help") {
    out(HELP);
    return EXIT_OK;
  }
  if (options === "version") {
    out(VERSION);
    return EXIT_OK;
  }

  const provider = providerFor(options.provider);
  if (!provider) {
    err(
      `No cost adapter for "${options.provider}". Supported: ${PROVIDER_IDS.join(", ")}.\n` +
        "A provider without an adapter gets no variance rather than a variance of zero:\n" +
        "zero would read as agreement with an invoice nobody read.",
    );
    return EXIT_USAGE;
  }

  // ── window ────────────────────────────────────────────────────────────────
  let window;
  try {
    window = resolveWindow({ from: options.from, to: options.to });
  } catch (error) {
    if (error instanceof WindowError) {
      err(error.message);
      return EXIT_USAGE;
    }
    throw error;
  }

  if (window.clampedFrom) {
    err(
      `Note: --to ${window.clampedFrom} includes today or later; the window ends ${window.to}. ` +
        "A part-day written as a whole one makes the variance look large every morning.",
    );
  }
  if (window.defaulted) {
    err(`Note: no window given, using the last ${window.days.length} complete UTC days.`);
  }

  // ── credential ────────────────────────────────────────────────────────────
  const envVar = options.keyEnv ?? provider.envVar;
  const credential = process.env[envVar]?.trim();
  if (!credential) {
    err(
      `${envVar} is not set.\n\n${provider.credentialHelp}\n\n` +
        `  export ${envVar}=...\n\n` +
        "It is read from the environment on purpose; there is no flag for it.",
    );
    return EXIT_USAGE;
  }

  // ── usage export ──────────────────────────────────────────────────────────
  let usageRows: ReturnType<typeof parseRows> | null = null;
  let adapter: AdapterDefinition | null = null;
  let rateCard = null;

  try {
    if (options.rates) {
      rateCard = parseRateCard(readFileOrStdin(options.rates));
    }

    if (options.usage) {
      const text = readFileOrStdin(options.usage);
      const rows = readRows(options.usage, text, options.fileFormat);
      if (rows.length === 0) {
        err(`${options.usage} contains no rows.`);
        return EXIT_USAGE;
      }

      if (options.format) {
        adapter = adapterFor(options.format);
        if (!adapter) {
          err(`Unknown --format "${options.format}". Supported: ${ADAPTERS.map((a) => a.id).join(", ")}.`);
          return EXIT_USAGE;
        }
      } else {
        adapter = detectAdapter(rows);
      }

      usageRows = parseRows(rows, adapter);

      if (usageRows.rows.length === 0) {
        err(
          `Read ${rows.length} rows from ${basename(options.usage)} as a ${adapter.label}, ` +
            "but none had both a timestamp and a model.\n" +
            usageRows.malformedExamples.map((line) => `  ${line}`).join("\n") +
            "\n\nThe contract is one row per request with: a timestamp, a model, and either a cost " +
            "or a token count.\nUse --format to pick a reader explicitly.",
        );
        return EXIT_USAGE;
      }
    }
  } catch (error) {
    if (error instanceof UsageFileError) {
      err(error.message);
      return EXIT_USAGE;
    }
    throw error;
  }

  // ── the provider's own figures ────────────────────────────────────────────
  let costDays;
  try {
    costDays = await provider.fetchDays(credential, {
      from: window.from,
      to: window.to,
      ...(options.verbose ? { onRequest: (url: string) => err(`  GET ${url}`) } : {}),
    });
  } catch (error) {
    if (error instanceof CostApiError) {
      err(`${provider.label} refused the request: ${error.message}`);
      if (error.permanent && (error.status === 401 || error.status === 403)) {
        err(`\n${provider.credentialHelp}`);
      }
      return EXIT_PROVIDER;
    }
    err(`Could not reach ${provider.label}: ${(error as Error).message}`);
    return EXIT_PROVIDER;
  }

  const nonUsd = costDays.find((day) => day.currency && day.currency !== "usd");
  if (nonUsd) {
    err(
      `${provider.label} reported ${nonUsd.day} in ${nonUsd.currency.toUpperCase()}, not USD. ` +
        "This tool does not convert currencies, and comparing across them would be meaningless.",
    );
    return EXIT_PROVIDER;
  }

  // ── compare ───────────────────────────────────────────────────────────────
  const comparison = compare({
    provider: provider.id as Vendor & string,
    from: window.from,
    to: window.to,
    costDays,
    usage: usageRows?.rows ?? [],
    rateCard,
    allRows: options.allRows,
  });

  if (options.json) {
    out(
      renderJson(comparison, provider, {
        version: VERSION,
        adapter: adapter?.id ?? null,
        usageFile: options.usage ?? null,
        generatedAt: new Date().toISOString(),
      }),
    );
  } else if (!options.usage) {
    if (comparison.days.length === 0) {
      out(`${provider.label} reported no cost between ${window.from} and ${window.to} (UTC, inclusive).`);
    } else {
      out(renderReportOnly(comparison, provider));
    }
  } else {
    out("");
    out(
      `${provider.label} cost report vs ${basename(options.usage)} ` +
        `(read as a ${adapter?.label}), ${window.from} to ${window.to} UTC`,
    );
    out("");
    if (comparison.days.length === 0) {
      out("Neither side has any figures in this window.");
    } else {
      out(renderTable(comparison, provider.label));
      out("");
      out(renderSummary(comparison, provider));
    }
    if (usageRows && usageRows.malformed > 0) {
      out("");
      out(
        `${usageRows.malformed.toLocaleString()} rows in the export had no usable timestamp or model ` +
          "and were skipped entirely.",
      );
    }
    out("");
  }

  if (options.failOver !== undefined && comparison.rate !== null) {
    if (Math.abs(comparison.rate) * 100 > options.failOver) {
      err(
        `Variance ${formatRate(comparison.rate)} exceeds the --fail-over threshold of ${options.failOver}%.`,
      );
      return EXIT_THRESHOLD;
    }
  }

  return EXIT_OK;
}

/**
 * Run only when this file *is* the program.
 *
 * Resolved through `realpathSync` because npm installs a `bin` as a symlink,
 * so `process.argv[1]` is the link and `import.meta.url` is its target. A
 * naive comparison makes the installed command silently do nothing.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`Unexpected failure: ${(error as Error).message}`);
      process.exitCode = EXIT_PROVIDER;
    });
}
