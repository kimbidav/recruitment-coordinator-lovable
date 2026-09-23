// Day-of interview reminder identity, ported from the desktop CalendarWriter.
//
// A reminder is "{First} x {Client}" at the reminder time (17:00) in the
// recruiter's timezone on the interview's local date. Two reminders are the
// SAME when the normalized candidate first-name token, the exact normalized
// client name and the local calendar date all match — substring matches such
// as Ann/Joanne must never collide, and moving an interview to another date
// is a new reminder. A deterministic Google event id derived from that
// identity closes the race between the duplicate lookup and the insert:
// concurrent attempts insert the same id, Google keeps one and answers 409
// for the other.

export const REMINDER_MINUTES = 30;
const SUMMARY_RE = /^(?<candidate>.+?)\s+x\s+(?<client>.+)$/;

export function normalizeName(value: string): string {
  return (value || "").split(/\s+/).filter(Boolean).join(" ").toLowerCase();
}

export function firstNameToken(value: string): string {
  return normalizeName(value).split(" ")[0] ?? "";
}

/** "Fan x Decagon (Onsite)" → [Fan, Decagon (Onsite)]. */
export function parseSummary(summary: string): [string, string] | null {
  const m = (summary || "").match(SUMMARY_RE);
  if (!m?.groups) return null;
  const candidate = m.groups.candidate.trim();
  const client = m.groups.client.trim();
  return candidate && client ? [candidate, client] : null;
}

/** Does an existing calendar summary denote the same (first name, client)? */
export function summaryMatches(summary: string, candidateName: string, clientName: string): boolean {
  const parsed = parseSummary(summary);
  if (!parsed) return false;
  const [itemCandidate, itemClient] = parsed;
  const withoutStage = itemClient.replace(/\s*\(.*\)\s*$/, "").trim();
  const wanted = normalizeName(clientName);
  return (
    !!firstNameToken(candidateName) &&
    firstNameToken(candidateName) === firstNameToken(itemCandidate) &&
    (wanted === normalizeName(itemClient) || wanted === normalizeName(withoutStage))
  );
}

export function reminderSummary(candidateName: string, clientName: string): string {
  const first = (candidateName || "").trim().split(/\s+/)[0] ?? "";
  return `${first} x ${(clientName || "").trim()}`;
}

/** Dedup key: first-name token, exact normalized client, local date. */
export function reminderKey(candidateName: string, clientName: string, localDate: string): string {
  return `${firstNameToken(candidateName)}\u0000${normalizeName(clientName)}\u0000${localDate}`;
}

const B32HEX = "0123456789abcdefghijklmnopqrstuv";
function base32hex(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32HEX[(value << (5 - bits)) & 31];
  return out;
}

/** WebCrypto in Deno/browsers; Node's webcrypto under vitest's node environment. */
async function subtleCrypto(): Promise<SubtleCrypto> {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto?.subtle) return g.crypto.subtle;
  const mod = await import("node:crypto");
  return (mod.webcrypto as unknown as Crypto).subtle;
}

/** Deterministic Google-compatible event id (base32hex alphabet, "rca" prefix). */
export async function stableEventId(candidateName: string, clientName: string, localDate: string): Promise<string> {
  const identity = reminderKey(candidateName, clientName, localDate);
  const subtle = await subtleCrypto();
  const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(identity)));
  return `rca${base32hex(digest)}`;
}

/** Wall-clock parts of an instant in a timezone. */
export function zonedParts(instant: Date, timeZone: string): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

/** Local calendar date (YYYY-MM-DD) of an ISO instant or bare date in a timezone. */
export function localDateOf(value: string, timeZone: string): string {
  const v = (value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return "";
  return zonedParts(new Date(t), timeZone).date;
}

/** The UTC instant of `localDate` at `HH:MM` wall time in `timeZone`. */
export function zonedTimeToUtc(localDate: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = localDate.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const [py, pm, pd] = p.date.split("-").map(Number);
    const wall = Date.UTC(py, pm - 1, pd, p.hour, p.minute);
    const diff = wall - target;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
