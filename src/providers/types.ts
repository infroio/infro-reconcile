/**
 * What a provider cost adapter is, and what it may not do.
 *
 * A provider that is not in `PROVIDERS` has no adapter, and the tool says so
 * and computes nothing. It must never fall back to a variance of zero: zero
 * reads as "your records agree with your invoice", which is the strongest
 * claim this tool can make, and asserting it about a provider nobody asked
 * would be the worst possible failure mode for a tool about honesty.
 */

import { USER_AGENT } from "../version.js";

/** One provider's cost for one UTC day, normalised to micro-USD. */
export interface CostDay {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  micros: bigint;
  currency: string;
  /** The provider's own breakdown, verbatim. Evidence, never attribution. */
  lineItems: { label: string; micros: bigint }[];
}

export interface FetchOptions {
  /** First UTC day, inclusive. */
  from: string;
  /** Last UTC day, inclusive. */
  to: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Called once per HTTP round trip, for `--verbose`. Never given the key. */
  onRequest?: (url: string) => void;
}

export interface CostProvider {
  /** The subcommand, and the key in `PROVIDERS`. */
  readonly id: string;
  readonly label: string;
  /** The environment variable the credential is read from. */
  readonly envVar: string;
  /** What kind of key it has to be, and where it comes from. */
  readonly credentialHelp: string;
  /** Documented gaps a user must know before trusting a variance. */
  readonly caveats: string[];
  fetchDays(credential: string, options: FetchOptions): Promise<CostDay[]>;
}

/** The provider said no, and said why. */
export class CostApiError extends Error {
  readonly status: number | null;
  /** True when retrying cannot help: wrong key, wrong key *class*, no access. */
  readonly permanent: boolean;

  constructor(message: string, options: { status?: number | null; permanent?: boolean } = {}) {
    super(message);
    this.name = "CostApiError";
    this.status = options.status ?? null;
    this.permanent = options.permanent ?? false;
  }
}

/**
 * A 4xx no retry can clear.
 *
 * 401 and 403 are the commonest failure here by a distance, because both
 * providers require an admin-scoped key and everybody's first instinct is to
 * paste the inference key they already have. 404 on these paths means the
 * account has no access to the endpoint at all.
 */
export function permanentStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404;
}

export async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const trimmed = text.trim().slice(0, 400);
  return trimmed || `HTTP ${response.status}`;
}

/**
 * One cost-API request: a User-Agent, and no redirects.
 *
 * The credential here is an organization Admin key — the most privileged thing
 * this tool ever holds — so a redirect is refused rather than followed with it
 * attached. `fetch` follows redirects by default and would re-send the
 * `Authorization` header to wherever it was pointed.
 */
export async function costFetch(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  onRequest?: (url: string) => void,
): Promise<Response> {
  onRequest?.(url);
  const response = await doFetch(url, {
    ...init,
    // Set here rather than per adapter so a new provider cannot forget it.
    // Anthropic's documentation asks integrations to identify themselves.
    headers: { "user-agent": USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new CostApiError(
      `The cost API answered with a redirect (HTTP ${response.status}). ` +
        `This tool does not follow redirects while carrying an Admin key.`,
      { status: response.status },
    );
  }
  return response;
}

/** Bounded pagination. A runaway cursor must not spin for ever. */
export const MAX_PAGES = 40;
