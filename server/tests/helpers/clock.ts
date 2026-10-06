// Small clock helpers for tests that need "a time earlier today".
//
// The trap this exists for: computing a wall-clock time by subtracting minutes
// from `Date.now()` crosses midnight for the first minutes of the day (at
// 00:01, "3 minutes ago" is 23:58 — a time *later* today, so the briefing is
// not due yet and not in its window). CI ran at exactly 00:00 UTC once and the
// morning-briefing tests failed for a reason that had nothing to do with the
// change under test. Everything here is clamped to the same calendar day.

/** True when both dates fall on the same local calendar day. */
export function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * "HH:MM" a few minutes before `now`, as the plan time a test pretends the
 * person chose. Never earlier than 00:00 today: at 00:01 the answer is "00:00"
 * (still in the past, still inside the 10-hour window) rather than yesterday's
 * 23:58 (which would read as "not due yet").
 */
export function minutesAgo(n: number, now: Date = new Date()): string {
  const then = new Date(now.getTime() - Math.max(0, n) * 60_000);
  const d = sameLocalDay(then, now)
    ? then
    : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "HH:MM" a while after `now`, clamped to the last minute of today (23:59). */
export function minutesFromNow(n: number, now: Date = new Date()): string {
  const then = new Date(now.getTime() + Math.max(0, n) * 60_000);
  const d = sameLocalDay(then, now)
    ? then
    : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
