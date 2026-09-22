/**
 * OpenAI: `GET /v1/organization/costs`.
 *
 * UNITS: `amount.value` is DOLLARS, as a JSON number. The documented example
 * is `{"value": 0.13080438340307526, "currency": "usd"}`, which is about
 * thirteen cents. See `../money.ts` for why that sentence is in this file.
 *
 * Verified against OpenAI's live documentation on 2026-09-20.
 *
 * CREDENTIAL: an Admin key (`sk-admin-...`), which is a different class from
 * the key that serves inference and can only be minted by an organization
 * owner. An inference key returns 401 here, which is the error most people
 * will meet first, so it is worth the sentence in `credentialHelp`.
 */

import { dollarsFloatToMicros } from "../money.js";
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

const ENDPOINT = "https://api.openai.com/v1/organization/costs";

interface CostsResponse {
  data?: {
    start_time?: number;
    results?: {
      amount?: { value?: number; currency?: string };
      line_item?: string | null;
    }[];
  }[];
  has_more?: boolean;
  next_page?: string | null;
}

export const openai: CostProvider = {
  id: "openai",
  label: "OpenAI",
  envVar: "OPENAI_ADMIN_KEY",
  credentialHelp:
    "An OpenAI Admin key (starts `sk-admin-`), created by an organization owner under " +
    "Settings → Admin keys. An ordinary inference key will not work: the costs endpoint " +
    "answers 401 for it.",
  caveats: [
    "Costs are reported per UTC day and can settle late; a figure for a recent day may still move.",
  ],

  async fetchDays(credential, options) {
    const doFetch = options.fetchImpl ?? fetch;
    const byDay = new Map<string, CostDay>();
    let page: string | null = null;

    for (let guard = 0; guard < MAX_PAGES; guard += 1) {
      const url = new URL(ENDPOINT);
      // Half-open: the API takes unix seconds, and `end_time` excludes itself,
      // while `--to` includes its own day.
      url.searchParams.set("start_time", String(Math.floor(dayStart(options.from).getTime() / 1000)));
      url.searchParams.set(
        "end_time",
        String(Math.floor(dayStart(addDays(options.to, 1)).getTime() / 1000)),
      );
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.set("limit", "31");
      url.searchParams.append("group_by[]", "line_item");
      if (page) url.searchParams.set("page", page);

      const response = await costFetch(
        doFetch,
        url.toString(),
        {
          headers: { authorization: `Bearer ${credential}`, accept: "application/json" },
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

      const body = (await response.json()) as CostsResponse;

      for (const bucket of body.data ?? []) {
        if (typeof bucket.start_time !== "number") continue;
        const day = utcDay(new Date(bucket.start_time * 1000));
        const entry = byDay.get(day) ?? { day, micros: 0n, currency: "usd", lineItems: [] };
        for (const result of bucket.results ?? []) {
          // DOLLARS. A float. The one line in this file that matters.
          const micros = dollarsFloatToMicros(result.amount?.value ?? 0);
          if (micros === 0n) continue;
          entry.micros += micros;
          entry.currency = (result.amount?.currency ?? entry.currency).toLowerCase();
          entry.lineItems.push({ label: result.line_item ?? "Usage", micros });
        }
        byDay.set(day, entry);
      }

      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }

    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  },
};
