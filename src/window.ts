/**
 * UTC days, and the rule that today is not one of them.
 *
 * WHY TODAY IS EXCLUDED
 *
 * A part-day written into a whole-day row makes the variance look enormous
 * every morning and shrink through the afternoon — a number that moves for
 * reasons unrelated to what it measures. It is also the failure that teaches
 * somebody to ignore the tool, because the first run of the day always shows a
 * large discrepancy and the discrepancy is never real.
 *
 * So the window ends yesterday. If the caller asks for today, the window is
 * clamped and the clamp is *stated* on stderr rather than applied quietly:
 * silently returning a different window than the one asked for is its own
 * small dishonesty.
 *
 * EVERYTHING HERE IS UTC
 *
 * Both cost APIs bucket by UTC day, so a local calendar would shift every row
 * by the operator's offset and produce a variance made entirely of time zones.
 * A `YYYY-MM-DD` in this tool is always a UTC day, and the README says so.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class WindowError extends Error {}

/** `YYYY-MM-DD` for an instant, in UTC. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Midnight UTC at the start of a `YYYY-MM-DD`. */
export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function addDays(day: string, count: number): string {
  return utcDay(new Date(dayStart(day).getTime() + count * DAY_MS));
}

/** Inclusive: `["2026-09-01", "2026-09-02", "2026-09-03"]`. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

/**
 * Parse a day a human typed.
 *
 * Deliberately strict. `09/01/2026` is September the first to an American and
 * the ninth of January to everyone else, and a tool whose output is a date
 * range must not guess which. ISO or nothing.
 */
export function parseDay(value: string, label: string): string {
  const trimmed = value.trim();
  if (!DAY_PATTERN.test(trimmed)) {
    throw new WindowError(`${label} must be a UTC date as YYYY-MM-DD, not "${value}".`);
  }
  const date = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || utcDay(date) !== trimmed) {
    throw new WindowError(`${label} is not a real date: "${value}".`);
  }
  return trimmed;
}

export interface Window {
  /** First UTC day, inclusive. */
  from: string;
  /** Last UTC day, inclusive. Never today, never later. */
  to: string;
  /** Every day in the window, inclusive. */
  days: string[];
  /** What the caller asked for, if it was cut back. */
  clampedFrom: string | null;
  /** True when the default window was used because none was given. */
  defaulted: boolean;
}

export interface WindowRequest {
  from?: string | undefined;
  to?: string | undefined;
  /** Injected by the tests. Wall clock otherwise. */
  now?: Date | undefined;
}

/** Days in the default window when the caller names neither end. */
export const DEFAULT_WINDOW_DAYS = 7;

/**
 * Resolve the window to complete UTC days.
 *
 * The default is the last seven *complete* days, ending yesterday — so a bare
 * invocation demonstrates the rule rather than explaining it.
 */
export function resolveWindow(request: WindowRequest = {}): Window {
  const now = request.now ?? new Date();
  const today = utcDay(now);
  const yesterday = addDays(today, -1);

  const defaulted = !request.from && !request.to;

  const requestedTo = request.to ? parseDay(request.to, "--to") : yesterday;
  const to = requestedTo > yesterday ? yesterday : requestedTo;
  const clampedFrom = to === requestedTo ? null : requestedTo;

  const from = request.from ? parseDay(request.from, "--from") : addDays(to, -(DEFAULT_WINDOW_DAYS - 1));

  if (from > to) {
    if (clampedFrom) {
      throw new WindowError(
        `The window contains no complete day: --from ${from} is after ${to}, the last day that has finished. ` +
          `Today (${today}) is excluded because a part-day cannot be compared against a whole one.`,
      );
    }
    throw new WindowError(`--from ${from} is after --to ${to}.`);
  }

  return { from, to, days: daysBetween(from, to), clampedFrom, defaulted };
}

/**
 * The half-open instant range the cost APIs take.
 *
 * Both endpoints want a start and an end that excludes its own day, while a
 * person asking for "the 1st to the 15th" means both. The conversion lives
 * here so that neither adapter has to be right about it separately.
 */
export function windowInstants(window: Window): { start: Date; end: Date } {
  return { start: dayStart(window.from), end: dayStart(addDays(window.to, 1)) };
}
