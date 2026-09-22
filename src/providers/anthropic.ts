/**
 * Anthropic: `GET /v1/organizations/cost_report`.
 *
 * UNITS: `amount` is CENTS, as a decimal string. Anthropic's documentation,
 * verbatim: "All costs in USD, reported as decimal strings in lowest units
 * (cents)". So `"41280.000000"` is $412.80, not $41,280.
 *
 * That is the hundredfold error this tool is partly written to prevent, and it
 * has been shipped in public by other people. `../money.ts` carries the whole
 * argument; `test/money.test.ts` asserts the two conversions do not collapse.
 *
 * Verified against Anthropic's live documentation on 2026-09-20.
 *
 * CREDENTIAL: an Admin key (`sk-ant-admin01-...`). A workspace-scoped key is
 * refused by the API itself, and the Admin API is unavailable for individual
 * accounts entirely.
 *
 * TWO DOCUMENTED GAPS, CARRIED RATHER THAN HIDDEN
 *
 * Anthropic states both, and a variance computed on an account affected by
 * either will not close. They are printed with the result, because a variance
 * with a known missing term is a different thing from a variance without one:
 *
 *   "Priority Tier costs use a different billing model and are not included in
 *    the cost endpoint."
 *
 *   "Claude Platform on AWS: The programmatic Usage and Cost API endpoints are
 *    not currently available."
 */

import { centsDecimalToMicros } from "../money.js";
import { addDays, dayStart, utcDay } from "../window.js";
import {
  CostApiError,
  MAX_PAGES,
  costFetch,
  permanentStatus,
  readErrorBody,
  type CostDay,
  type CostProvider,
} from "./types.js";

const ENDPOINT = "https://api.anthropic.com/v1/organizations/cost_report";

interface CostReportResponse {
  data?: {
    starting_at?: string;
    results?: {
      amount?: string | number;
      currency?: string;
      description?: string | null;
      model?: string | null;
    }[];
  }[];
  has_more?: boolean;
  next_page?: string | null;
}

export const anthropic: CostProvider = {
  id: "anthropic",
  label: "Anthropic",
  envVar: "ANTHROPIC_ADMIN_KEY",
  credentialHelp:
    "An Anthropic Admin key (starts `sk-ant-admin`), created by an organization admin in the " +
    "Console under Settings. A workspace-scoped key will not work, and the Admin API is " +
    "unavailable for individual accounts.",
  caveats: [
    "Priority Tier spend is not included in the cost endpoint at all. On an account that uses it, this variance is missing a term by design.",
    "The cost endpoint is unavailable for Claude on AWS. Usage served through Bedrock is billed by AWS and will not appear here.",
    "Code execution appears under the description `Code Execution Usage`; it has no matching row in most usage exports.",
  ],

  async fetchDays(credential, options) {
    const doFetch = options.fetchImpl ?? fetch;
    const byDay = new Map<string, CostDay>();
    let page: string | null = null;

    for (let guard = 0; guard < MAX_PAGES; guard += 1) {
      const url = new URL(ENDPOINT);
      // Half-open, same as OpenAI, from a `--to` that includes its own day.
      url.searchParams.set("starting_at", dayStart(options.from).toISOString());
      url.searchParams.set("ending_at", dayStart(addDays(options.to, 1)).toISOString());
      // 31 is the documented maximum for daily buckets, and daily is the only
      // granularity this endpoint offers.
      url.searchParams.set("limit", "31");
      url.searchParams.append("group_by[]", "description");
      if (page) url.searchParams.set("page", page);

      const response = await costFetch(
        doFetch,
        url.toString(),
        {
          headers: {
            "x-api-key": credential,
            "anthropic-version": "2023-06-01",
            accept: "application/json",
          },
          ...(options.signal ? { signal: options.signal } : {}),
        },
        options.onRequest,
      );

      if (!response.ok) {
        throw new CostApiError(await readErrorBody(response), {
          status: response.status,
          permanent: permanentStatus(response.status),
        });
      }

      const body = (await response.json()) as CostReportResponse;

      for (const bucket of body.data ?? []) {
        if (typeof bucket.starting_at !== "string") continue;
        const day = utcDay(new Date(bucket.starting_at));
        const entry = byDay.get(day) ?? { day, micros: 0n, currency: "usd", lineItems: [] };
        for (const result of bucket.results ?? []) {
          // CENTS. A decimal string. A number is accepted defensively, because
          // it costs one branch and the alternative is a hundredfold error.
          const micros = centsDecimalToMicros(String(result.amount ?? "")) ?? 0n;
          if (micros === 0n) continue;
          entry.micros += micros;
          entry.currency = (result.currency ?? entry.currency).toLowerCase();
          entry.lineItems.push({ label: result.model ?? result.description ?? "Usage", micros });
        }
        byDay.set(day, entry);
      }

      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }

    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  },
};
