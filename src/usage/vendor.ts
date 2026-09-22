/**
 * Which provider billed a row.
 *
 * WHY THIS EXISTS AT ALL
 *
 * A usage export is usually a mixed log: OpenAI, Anthropic and whatever else
 * the application calls, in one table. Comparing all of it against one
 * provider's invoice produces a variance made of the other providers, and it
 * would look like a large, confident finding.
 *
 * So rows are attributed, and only the ones belonging to the provider being
 * reconciled are compared. Rows that belong to somebody else are *counted and
 * named*, never silently dropped — a line saying "1,204 rows excluded: 812
 * anthropic, 392 bedrock" is how a reader checks that the filter did what they
 * think it did.
 *
 * THE CASE THAT MATTERS MOST: CLAUDE THAT ANTHROPIC DID NOT BILL
 *
 * A Claude model served through Bedrock or Vertex is billed by AWS or Google,
 * and Anthropic's cost endpoint is explicitly unavailable for Claude on AWS.
 * Counting those rows against Anthropic's invoice makes the export side look
 * inflated for a reason that is nothing to do with anybody's rates.
 *
 * An explicit provider column settles it. Without one, model *shape* is a
 * strong signal and is used:
 *
 *   anthropic.claude-sonnet-4-5-20250929-v1:0   Bedrock  (vendor prefix + `:n` revision)
 *   claude-sonnet-4-5@20250929                  Vertex   (`@` version separator)
 *   claude-sonnet-4-5-20250929                  Anthropic direct
 *
 * That is a heuristic, it is documented as one in the README, and it is only
 * consulted when the export did not say.
 */

export type Vendor = "openai" | "anthropic" | "other" | "unknown";

export interface Attribution {
  vendor: Vendor;
  /** Where it came from, for the excluded-rows summary. */
  reason: string;
}

/**
 * Values an export may put in a provider column, mapped to who sends the
 * invoice. LiteLLM writes `custom_llm_provider`; several others copy it.
 */
const PROVIDER_COLUMN: Record<string, Vendor> = {
  openai: "openai",
  "openai-compatible": "unknown",
  azure: "other",
  azure_ai: "other",
  azure_openai: "other",
  anthropic: "anthropic",
  bedrock: "other",
  bedrock_converse: "other",
  aws: "other",
  sagemaker: "other",
  vertex_ai: "other",
  vertex_ai_beta: "other",
  gemini: "other",
  google: "other",
  openrouter: "other",
  together_ai: "other",
  groq: "other",
  mistral: "other",
  cohere: "other",
  fireworks_ai: "other",
  deepseek: "other",
  xai: "other",
  ollama: "other",
};

const OPENAI_PREFIXES = [
  "gpt-",
  "gpt.",
  "gpt4",
  "gpt3",
  "chatgpt",
  "o1",
  "o3",
  "o4",
  "codex",
  "text-embedding-",
  "text-davinci",
  "davinci",
  "babbage",
  "curie",
  "ada",
  "dall-e",
  "whisper",
  "tts-",
  "omni-moderation",
  "text-moderation",
  "sora",
];

/**
 * Strip a routing prefix an aggregator added.
 *
 * `openai/gpt-4o`, `anthropic/claude-sonnet-4-5`. The prefix is itself the
 * strongest signal there is, so it is read before it is removed — but only
 * when it names a vendor rather than a deployment.
 */
function splitRoutingPrefix(model: string): { prefix: string | null; rest: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) return { prefix: null, rest: model };
  return { prefix: model.slice(0, slash), rest: model.slice(slash + 1) };
}

/**
 * Attribute one row.
 *
 * `providerColumn` wins whenever the export supplied one: it is the exporter's
 * own answer, and it knows things the model name cannot carry.
 */
export function attribute(model: string, providerColumn?: string | null): Attribution {
  const declared = providerColumn?.trim().toLowerCase();
  if (declared) {
    const mapped = PROVIDER_COLUMN[declared];
    if (mapped && mapped !== "unknown") {
      return { vendor: mapped, reason: declared };
    }
    if (mapped === "unknown") {
      return { vendor: "unknown", reason: `${declared} (an endpoint, not a vendor)` };
    }
  }

  const raw = model.trim();
  if (!raw) return { vendor: "unknown", reason: "no model" };

  const { prefix, rest } = splitRoutingPrefix(raw.toLowerCase());
  if (prefix === "openai") return { vendor: "openai", reason: "model prefix `openai/`" };
  if (prefix === "anthropic") return { vendor: "anthropic", reason: "model prefix `anthropic/`" };
  if (prefix && prefix !== "openai" && prefix !== "anthropic" && PROVIDER_COLUMN[prefix]) {
    return { vendor: PROVIDER_COLUMN[prefix] ?? "unknown", reason: `model prefix \`${prefix}/\`` };
  }

  const name = rest;

  // Bedrock and Vertex first: a Claude billed by AWS or Google is not an
  // Anthropic invoice line, and this is the whole reason the shapes are read.
  if (name.startsWith("anthropic.") || /:\d+$/.test(name)) {
    return { vendor: "other", reason: "Bedrock model id (billed by AWS)" };
  }
  if (name.includes("@")) {
    return { vendor: "other", reason: "Vertex model id (billed by Google)" };
  }

  if (name.startsWith("claude")) return { vendor: "anthropic", reason: "model name" };
  if (OPENAI_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return { vendor: "openai", reason: "model name" };
  }

  return { vendor: "unknown", reason: `unrecognised model \`${model.trim()}\`` };
}
