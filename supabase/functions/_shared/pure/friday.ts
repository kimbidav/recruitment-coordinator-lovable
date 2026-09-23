// Friday-EOW rule for ambiguous scheduling emails ("I grabbed a time", no
// date): the follow-up is the Friday of the email's week; an email sent
// Fri–Sun rolls to the next Friday. Deterministic, applied after the LLM so
// model drift can't break the rule. Computed in the recruiter's timezone.

function ymd(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function weekday(iso: string): number {
  // Mon=0 … Sun=6, matching Python's weekday(); ISO dates are calendar-local.
  const d = new Date(`${iso}T12:00:00Z`);
  return (d.getUTCDay() + 6) % 7;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param followupDate  the LLM's proposal (trusted only if it is a Friday)
 * @param anchorDate    the email's inferred YYYY-MM-DD, if any
 * @param now           fallback anchor
 * @param tz            IANA timezone for "today"
 */
export function normalizeFollowupToFriday(
  followupDate: string | null | undefined,
  anchorDate: string | null | undefined,
  now: Date,
  tz = "UTC",
): string {
  if (followupDate && ISO.test(followupDate) && weekday(followupDate) === 4) return followupDate;
  const anchor = anchorDate && ISO.test(anchorDate) ? anchorDate : ymd(now, tz);
  const wd = weekday(anchor);
  // Mon–Thu -> this week's Friday; Fri/Sat/Sun -> next Friday.
  const delta = wd <= 3 ? 4 - wd : 11 - wd;
  return addDays(anchor, delta);
}
