import { anthropic } from "./anthropic.js";
import { openai } from "./openai.js";
import type { CostProvider } from "./types.js";

/**
 * The providers that can be reconciled today.
 *
 * A provider absent from this map has no cost adapter, and the CLI says
 * exactly that and exits. It never shows a variance of zero — see
 * `./types.ts` for why that particular lie is the one to avoid.
 *
 * Bedrock, Vertex and Azure are absent deliberately: their cost lives in the
 * surrounding cloud's billing system, behind IAM that has nothing to do with
 * an API key, and each is a separate integration.
 */
export const PROVIDERS: Record<string, CostProvider> = {
  [openai.id]: openai,
  [anthropic.id]: anthropic,
};

export function providerFor(id: string): CostProvider | null {
  return PROVIDERS[id.toLowerCase()] ?? null;
}

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export { anthropic, openai };
export * from "./types.js";
