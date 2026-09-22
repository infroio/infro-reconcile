/**
 * The version, hardcoded here and in `package.json`.
 *
 * Two copies, which is the point: this one goes out in the `User-Agent` that a
 * provider — and whoever is reading a support ticket — sees on every request.
 * Nothing but the release gate notices when the two drift, and the symptom is
 * silent: a 0.2.0 package that identifies itself as 0.1.0 everywhere, so the
 * first question anybody asks is answered wrongly.
 *
 * `sdks/scripts/check-release.mjs` asserts they agree.
 */
export const VERSION = "0.1.2";

/**
 * Anthropic's documentation asks integrations to identify themselves this way,
 * and it is good manners at OpenAI too. It carries no account identifier and
 * nothing about the caller.
 */
export const USER_AGENT = `infro-reconcile/${VERSION} (+https://infro.io)`;
