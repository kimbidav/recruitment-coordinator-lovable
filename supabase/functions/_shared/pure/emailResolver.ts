// Candidate email resolution — surname-anchored, evidence-based, confidence-
// gated. Pure port of weekly_slack_recon/candidate_outreach.py
// (parse_candidate_name, _build_queries, score_candidate_messages).
//
// Why: "Look up from Gmail" used to run `from:"First Last"` then fall back to
// `from:"First"` and return the FIRST hit's sender. That routinely landed on a
// colleague or a client contact — DJ (Krishnamurthy) Dvijotham came back as
// djdeanda@candidatelabs.com with a green "Found" badge while his real address
// sat in DK's sent mail, his replies and a Calendly "Invitee Email:" notice.
// The same lookup prefills Add to Ashby, where the address becomes the
// candidate's primary email in the CLIENT's ATS, so a wrong guess is
// client-visible and undone by hand.
//
// Rules: never a first-name-only query; internal / own / system addresses are
// never candidates; `email` is set only at high or medium confidence.

export const DEFAULT_INTERNAL_DOMAINS: readonly string[] = ["candidatelabs.com"];

const SYSTEM_DOMAIN_SUFFIXES = [
  "superhuman.com", "zoom.us", "metaview.ai", "calendly.com", "google.com",
  "linkedin.com", "ashbyhq.com", "greenhouse.io", "greenhouse-mail.io", "lever.co",
  "slack.com", "granola.ai", "fathom.video", "cal.com", "goodtime.io",
  "docusign.net", "docusign.com", "sendgrid.net", "mailchimp.com", "mailgun.org",
  "amazonses.com", "intercom-mail.com", "zoominfo.com", "apollo.io", "gem.com",
  "wellfound.com", "hired.com", "indeed.com", "glassdoor.com", "workable.com",
  "bamboohr.com", "hirevue.com", "codesignal.com", "hackerrank.com",
];
const SYSTEM_LOCAL_PREFIXES = [
  "noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "do_not_reply",
  "notifications", "notification", "reminder", "reminders", "calendar-notification",
  "mailer-daemon", "postmaster", "bounce", "bounces", "alerts", "alert", "digest",
  "newsletter", "news", "marketing", "updates", "invitations", "invites", "scheduling",
  "calendar", "meetings", "system", "robot", "bot", "auto", "automated",
];
const SYSTEM_LOCAL_EXACT = new Set([
  "support", "hello", "info", "team", "sales", "careers", "jobs", "recruiting",
  "talent", "hr", "hiring", "people", "admin", "billing", "contact", "help",
  "security", "privacy", "legal", "press", "media", "events", "feedback",
]);
const SCHEDULING_NOTICE_DOMAINS = ["zoom.us", "metaview.ai", "calendly.com", "fathom.video", "granola.ai", "cal.com", "goodtime.io"];
const CALENDLY_DOMAINS = ["calendly.com"];
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "yahoo.com", "ymail.com", "rocketmail.com", "icloud.com", "me.com",
  "mac.com", "proton.me", "protonmail.com", "protonmail.ch", "pm.me",
  "fastmail.com", "fastmail.fm", "hey.com", "aol.com", "zoho.com", "gmx.com",
  "gmx.net", "duck.com", "tutanota.com", "tuta.io", "mail.com", "posteo.de",
  "qq.com", "163.com", "126.com", "naver.com", "yandex.com",
]);
const PERSONAL_DOMAIN_PREFIXES = ["proton", "yahoo.", "outlook.", "hotmail.", "live.", "gmx."];
const COMMON_WORD_SURNAMES = new Set(`
white black brown green gray grey king young long hill wood stone bell rose cook
baker hall ward price love best good may day week miller summer winter north south
east west little small bush lane park field moon star sun rice fox wolf bird fish
bank book case hope grace joy frost snow rain storm reed read chase gold silver steel
ford strong sharp wise noble power bright free dear fair lord marks mark page post ray
ross jolly happy merry swift quick church castle bridge river lake forest glass
bishop knight hunter fisher carpenter mason taylor smith cooper parker turner walker
butler brewer farmer shepherd singer archer dean judge marshall page sergeant
hart heart dove crane hawk swan drake bull lamb fowler mills wells brooks banks
woods fields burns ball bond cross march mayo money morning night noon oak olive
pepper pitt pool rush sands short stern still sweet thorn town tree wall waters wild
well west winter world rich poor old new grand great high low light dark early late
true just right left last first second gates gate gay done real royal royale
`.split(/\s+/).filter(Boolean));
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "md", "mba", "esq"]);

export function asciiFold(text: string): string {
  return (text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
function nameTokens(text: string): string[] {
  return asciiFold(text).match(/[a-z0-9]+/g) ?? [];
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ParsedName {
  firsts: string[];
  surname: string;
  single_token: boolean;
  display_firsts: string[];
  display_surname: string;
  searchable_surname: boolean;
}

/**
 * "DJ (Krishnamurthy) Dvijotham" → firsts [dj, krishnamurthy], surname dvijotham.
 * `searchable_surname` is false when a bare surname query would be noise
 * (< 4 chars or a common English word).
 */
export function parseCandidateName(raw: string): ParsedName {
  let s = (raw || "").trim();
  const parens = Array.from(s.matchAll(/\(([^)]*)\)/g), (m) => m[1]);
  s = s.replace(/\([^)]*\)/g, " ");
  const quoted = Array.from(s.matchAll(/["“”]([^"“”]+)["“”]/g), (m) => m[1]);
  s = s.replace(/["“”][^"“”]+["“”]/g, " ");

  const tokens: string[] = [];
  const display: string[] = [];
  for (let t of s.split(/\s+/)) {
    t = t.replace(/^[ \t–—,|;:./\\-]+|[ \t–—,|;:./\\-]+$/g, "");
    if (!t || !/[A-Za-z]/.test(t)) continue;
    const folded = nameTokens(t).join("");
    if (!folded || NAME_SUFFIXES.has(folded)) continue;
    tokens.push(folded);
    display.push(t);
  }
  const firsts: string[] = [];
  const displayFirsts: string[] = [];
  let surname = "";
  let displaySurname = "";
  let single = false;
  if (tokens.length >= 2) {
    firsts.push(tokens[0]);
    displayFirsts.push(display[0]);
    surname = tokens[tokens.length - 1];
    displaySurname = display[display.length - 1];
  } else if (tokens.length === 1) {
    surname = tokens[0];
    displaySurname = display[0];
    single = true;
  }
  for (const extra of [...parens, ...quoted]) {
    const et = extra.trim().split(/\s+/).filter((t) => /[A-Za-z]/.test(t));
    // Only single-word alphabetic parentheticals are name variants —
    // "(he/him)", "(Staff Eng, ex-Stripe)", "(2x)" are ignored.
    if (et.length !== 1 || !/^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'-]*\.?$/.test(et[0])) continue;
    const folded = nameTokens(et[0]).join("");
    if (!folded || firsts.includes(folded) || folded === surname || folded.length < 2) continue;
    firsts.push(folded);
    displayFirsts.push(et[0].replace(/^[ ,.\-–—]+|[ ,.\-–—]+$/g, ""));
  }
  return {
    firsts,
    surname,
    single_token: single,
    display_firsts: displayFirsts,
    display_surname: displaySurname,
    searchable_surname: !!surname && surname.length >= 4 && !COMMON_WORD_SURNAMES.has(surname),
  };
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** 'Name <a@b.c>' → [Name, a@b.c]; bare address → ['', a@b.c]. */
export function splitAddress(value: string): [string, string] {
  const v = value || "";
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return [m[1].trim(), m[2].trim().toLowerCase()];
  const e = v.match(EMAIL_RE);
  return ["", e ? e[0].toLowerCase() : ""];
}

/** Every (display, address) pair in a To/Cc header. */
export function addressesIn(header: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  // Split on commas outside quotes / angle brackets.
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let quote = false;
  for (const ch of header || "") {
    if (ch === '"') quote = !quote;
    else if (!quote && ch === "<") depth++;
    else if (!quote && ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && !quote && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  for (const p of parts) {
    const [name, addr] = splitAddress(p);
    if (addr.includes("@")) out.push([name, addr]);
  }
  return out;
}

function domainOf(addr: string): string {
  return addr.includes("@") ? addr.slice(addr.lastIndexOf("@") + 1).toLowerCase() : "";
}
function domainIn(dom: string, list: readonly string[]): boolean {
  return list.some((d) => dom === d || dom.endsWith("." + d));
}

export function isInternalAddress(addr: string, internalDomains: readonly string[], ownAddresses: readonly string[]): boolean {
  if (!addr) return true;
  if (ownAddresses.includes(addr)) return true;
  return domainIn(domainOf(addr), internalDomains);
}

export function isSystemAddress(addr: string): boolean {
  if (!addr || !addr.includes("@")) return true;
  const at = addr.lastIndexOf("@");
  const local = addr.slice(0, at).toLowerCase();
  const dom = addr.slice(at + 1).toLowerCase();
  if (domainIn(dom, SYSTEM_DOMAIN_SUFFIXES)) return true;
  if (SYSTEM_LOCAL_EXACT.has(local)) return true;
  if (SYSTEM_LOCAL_PREFIXES.some((p) => local.startsWith(p) && !/[a-z]/i.test(local.slice(p.length, p.length + 1)))) return true;
  if (local.includes("noreply") || local.includes("no-reply") || local.includes("donotreply")) return true;
  return false;
}
const isSchedulingNoticeSender = (addr: string) => domainIn(domainOf(addr), SCHEDULING_NOTICE_DOMAINS);
export const isCalendlySender = (addr: string) => domainIn(domainOf(addr), CALENDLY_DOMAINS);
function isPersonalDomain(addr: string): boolean {
  const dom = domainOf(addr);
  if (!dom) return false;
  if (PERSONAL_DOMAINS.has(dom) || dom.endsWith(".edu") || dom.includes(".edu.")) return true;
  return PERSONAL_DOMAIN_PREFIXES.some((p) => dom.startsWith(p));
}

function tokenMatches(token: string, needle: string): boolean {
  if (!token || !needle) return false;
  if (token === needle) return true;
  if (needle.length >= 3 && token.length >= 3) return token.startsWith(needle) || needle.startsWith(token);
  return false;
}
function localContains(local: string, needle: string): boolean {
  if (!needle) return false;
  const alnum = local.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (needle.length >= 3) return alnum.includes(needle);
  const re = new RegExp(`(^|[._\\-])${escapeRe(needle)}($|[._\\-])`);
  return re.test(local.toLowerCase()) || alnum.startsWith(needle) || alnum.endsWith(needle);
}

function matchName(display: string, addr: string, parsed: ParsedName) {
  const { surname, firsts } = parsed;
  const dt = nameTokens(display);
  const local = addr.includes("@") ? addr.slice(0, addr.indexOf("@")) : addr;
  let surnameHit = false;
  let surnameDisplay = false;
  if (surname) {
    if (dt.some((t) => t === surname)) surnameHit = surnameDisplay = true;
    else if (surname.length >= 6 && dt.join("").includes(surname)) surnameHit = surnameDisplay = true;
    else if (localContains(local, surname)) surnameHit = true;
  }
  let firstHit = false;
  let firstWeak = false;
  for (const f of firsts) {
    if (dt.some((t) => tokenMatches(t, f))) { firstHit = true; break; }
    if (f.length >= 3 && localContains(local, f)) { firstHit = true; break; }
    if (f.length === 2 && dt.some((t) => t === f)) { firstHit = true; break; }
    if (dt.some((t) => t.length === 1 && t === f[0])) firstWeak = true;
  }
  let conflict = false;
  if (surnameHit && firsts.length && !firstHit && !firstWeak && dt.length >= 2) {
    const others = dt.filter((t) => t !== surname);
    if (others.length && others.every((t) => t.length >= 2)) conflict = true;
  }
  return { surname: surnameHit, surname_display: surnameDisplay, first: firstHit, conflict };
}

function surnameInText(text: string, parsed: ParsedName): boolean {
  const { surname, firsts } = parsed;
  const folded = asciiFold(text);
  if (!surname || surname.length < 3) {
    return !!surname && firsts.some((f) => new RegExp(`\\b${escapeRe(f)}\\s+${escapeRe(surname)}\\b`).test(folded));
  }
  return new RegExp(`\\b${escapeRe(surname)}\\b`).test(folded);
}

export interface PlannedQuery { q: string; anchor: boolean }

/** Ordered Gmail queries. Invariant: no first-name-only query, ever. */
export function buildQueries(parsed: ParsedName, internalDomains: readonly string[] = DEFAULT_INTERNAL_DOMAINS, lookback = "18m"): PlannedQuery[] {
  const firsts = parsed.display_firsts;
  const surname = parsed.display_surname;
  const out: PlannedQuery[] = [];
  const exclude = internalDomains.map((d) => `-from:${d}`).join(" ");
  if (parsed.single_token) {
    if (parsed.surname.length >= 4) {
      out.push({ q: `from:"${surname}" OR to:"${surname}" OR cc:"${surname}"`, anchor: true });
      if (parsed.searchable_surname) {
        out.push({ q: `from:me "${surname}" newer_than:${lookback}`, anchor: true });
        out.push({ q: `"${surname}" ${exclude} newer_than:${lookback}`.trim(), anchor: true });
      }
    }
    return out;
  }
  const phrases = firsts.map((f) => `${f} ${surname}`).slice(0, 3);
  for (const p of phrases) out.push({ q: `from:"${p}" OR to:"${p}" OR cc:"${p}"`, anchor: true });
  if (parsed.searchable_surname) {
    out.push({ q: `from:me "${surname}" newer_than:${lookback}`, anchor: true });
    out.push({ q: `"${surname}" ${exclude} newer_than:${lookback}`.trim(), anchor: true });
  } else {
    for (const p of phrases) out.push({ q: `"${p}" newer_than:${lookback}`, anchor: true });
  }
  return out;
}

export interface ResolverMessage {
  id: string;
  threadId: string;
  headers: { From?: string; To?: string; Cc?: string; Subject?: string; Date?: string };
  snippet: string;
  /** YYYY-MM-DD */
  date: string;
  /** The query that returned this message itself required the surname. */
  anchor: boolean;
  body?: string;
}

export type EvidenceKind = "you_emailed" | "they_emailed" | "calendly_invitee" | "mention" | "scheduling_notice";
export interface Evidence { kind: EvidenceKind; subject: string; date: string; detail: string }
export type Confidence = "high" | "medium" | "low" | "none";
export interface ScoredCandidate {
  email: string;
  score: number;
  confidence: Exclude<Confidence, "none">;
  surname_matched: boolean;
  first_matched: boolean;
  bidirectional: boolean;
  threads: number;
  display_names: string[];
  evidence: Evidence[];
}

const CALENDLY_INVITEE_RE = /Invitee:\s*(.*?)\s*Invitee\s*Email:\s*([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/is;

function htmlUnescape(s: string): string {
  return (s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

interface Rec {
  email: string; display_names: Set<string>; surname: boolean; surname_display: boolean; first: boolean;
  conflict: boolean; cooccur: boolean; you_emailed: boolean; they_emailed: boolean; calendly: boolean; mention: boolean;
  threads: Set<string>; evidence: Evidence[];
}

/** Pure scoring step (no network). */
export function scoreCandidateMessages(
  messages: ResolverMessage[],
  parsed: ParsedName,
  opts: { internalDomains?: readonly string[]; ownAddresses?: readonly string[] } = {},
): { candidates: ScoredCandidate[]; supporting: Evidence[] } {
  const internal = (opts.internalDomains ?? DEFAULT_INTERNAL_DOMAINS).map((d) => d.toLowerCase());
  const own = (opts.ownAddresses ?? []).map((a) => a.toLowerCase());
  const byAddr = new Map<string, Rec>();
  const supporting: Evidence[] = [];
  const rec = (addr: string): Rec => {
    let r = byAddr.get(addr);
    if (!r) {
      r = { email: addr, display_names: new Set(), surname: false, surname_display: false, first: false, conflict: false, cooccur: false,
        you_emailed: false, they_emailed: false, calendly: false, mention: false, threads: new Set(), evidence: [] };
      byAddr.set(addr, r);
    }
    return r;
  };
  const note = (addr: string, display: string, kind: Exclude<EvidenceKind, "scheduling_notice">, msg: ResolverMessage, detail: string, msgHasSurname: boolean) => {
    if (!addr || !addr.includes("@")) return;
    if (isInternalAddress(addr, internal, own) || isSystemAddress(addr)) return;
    const r = rec(addr);
    const m = matchName(display, addr, parsed);
    if (display) r.display_names.add(display);
    if (m.surname) r.surname = true;
    if (m.surname_display) r.surname_display = true;
    if (m.first) { r.first = true; if (msgHasSurname) r.cooccur = true; }
    if (m.conflict) r.conflict = true;
    if (kind === "calendly_invitee") r.calendly = true;
    else r[kind] = true;
    if (msg.threadId) r.threads.add(msg.threadId);
    r.evidence.push({ kind, subject: msg.headers.Subject ?? "", date: msg.date ?? "", detail });
  };

  for (const msg of messages) {
    const h = msg.headers || {};
    const [fromDisplay, fromAddr] = splitAddress(h.From ?? "");
    const subject = h.Subject ?? "";
    const snippet = htmlUnescape(msg.snippet ?? "");
    const body = msg.body ?? "";
    const blob = [subject, snippet, body, h.From ?? "", h.To ?? "", h.Cc ?? ""].join(" ");
    const msgHasSurname = !!msg.anchor || surnameInText(blob, parsed);
    const recipients = [...addressesIn(h.To ?? ""), ...addressesIn(h.Cc ?? "")];

    if (isInternalAddress(fromAddr, internal, own)) {
      const [kind, detail]: [Exclude<EvidenceKind, "scheduling_notice">, string] = own.includes(fromAddr)
        ? ["you_emailed", "You emailed them"]
        : ["mention", `Emailed by ${fromAddr}`];
      for (const [disp, addr] of recipients) note(addr, disp, kind, msg, detail, msgHasSurname);
      continue;
    }
    if (isCalendlySender(fromAddr)) {
      const text = snippet + " " + body;
      const m = text.match(CALENDLY_INVITEE_RE);
      if (m) {
        const inviteeName = m[1].replace(/\s+/g, " ").trim();
        note(m[2].toLowerCase(), inviteeName, "calendly_invitee", msg, `Calendly invitee: ${inviteeName}`, msgHasSurname);
      } else {
        const found = (text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()).filter((e) => !isSystemAddress(e) && !isInternalAddress(e, internal, own));
        if (found.length === 1) note(found[0], snippet.slice(0, 200), "calendly_invitee", msg, "Calendly invitee", msgHasSurname);
        else supporting.push({ kind: "scheduling_notice", subject, date: msg.date ?? "", detail: "Calendly notice" });
      }
      continue;
    }
    if (isSchedulingNoticeSender(fromAddr) || isSystemAddress(fromAddr)) {
      if (isSchedulingNoticeSender(fromAddr) && (surnameInText(blob, parsed) || msg.anchor)) {
        supporting.push({ kind: "scheduling_notice", subject, date: msg.date ?? "", detail: `${domainOf(fromAddr)} notice` });
      }
      continue;
    }
    note(fromAddr, fromDisplay, "they_emailed", msg, "They emailed you", msgHasSurname);
    for (const [disp, addr] of recipients) if (addr !== fromAddr) note(addr, disp, "mention", msg, "Copied on a thread", msgHasSurname);
  }

  const out: ScoredCandidate[] = [];
  for (const [addr, r] of byAddr) {
    const surnameMatched = r.surname || (r.first && r.cooccur);
    if (!r.surname && !r.first) continue;
    let score = 0;
    if (r.surname) score += 3;
    else if (surnameMatched) score += 2;
    if (r.first) score += 2;
    if (r.you_emailed) score += 2;
    if (r.they_emailed) score += 2;
    if (r.calendly) score += 2;
    const threads = r.threads.size;
    if (threads > 1) score += Math.min(3, threads - 1);
    if (isPersonalDomain(addr)) score += 1;
    if (r.conflict) score -= 3;
    if (score <= 0) continue;
    const bidirectional = r.you_emailed && r.they_emailed;
    // A surname that only appears inside the local-part ("arul18.gupta@")
    // with no first-name signal is "some Gupta", not this one.
    const identityOk = (r.first || r.surname_display || r.calendly) && !r.conflict;
    let confidence: ScoredCandidate["confidence"];
    if (surnameMatched && identityOk && (bidirectional || threads >= 2 || (r.calendly && r.you_emailed)) && score >= 6) confidence = "high";
    else if (surnameMatched && identityOk && score >= 4) confidence = "medium";
    else confidence = "low";
    if (parsed.single_token && confidence === "high") confidence = "medium";

    const kindRank: Record<string, number> = { they_emailed: 0, you_emailed: 1, calendly_invitee: 2, mention: 3, scheduling_notice: 4 };
    const buckets = new Map<string, Evidence[]>();
    const seen = new Set<string>();
    for (const e of [...r.evidence].sort((a, b) => (b.date || "").localeCompare(a.date || ""))) {
      const key = `${e.kind}\u0000${e.subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!buckets.has(e.kind)) buckets.set(e.kind, []);
      buckets.get(e.kind)!.push(e);
    }
    const evidence: Evidence[] = [];
    const kinds = Array.from(buckets.keys()).sort((a, b) => (kindRank[a] ?? 9) - (kindRank[b] ?? 9));
    while (Array.from(buckets.values()).some((b) => b.length)) {
      for (const k of kinds) {
        const b = buckets.get(k)!;
        if (b.length) evidence.push(b.shift()!);
      }
    }
    out.push({
      email: addr, score, confidence, surname_matched: !!surnameMatched, first_matched: r.first, bidirectional,
      threads, display_names: Array.from(r.display_names).sort().slice(0, 3), evidence,
    });
  }
  const rank = { high: 3, medium: 2, low: 1 } as const;
  out.sort((a, b) => rank[b.confidence] - rank[a.confidence] || b.score - a.score || b.threads - a.threads);
  supporting.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return { candidates: out, supporting };
}

export interface ResolveResult {
  email: string | null;
  confidence: Confidence;
  evidence: Evidence[];
  candidates: Array<{ email: string; confidence: string; score: number; display_names: string[]; evidence: Evidence[] }>;
  queries: string[];
  supporting: Evidence[];
  name: { firsts: string[]; surname: string };
  error?: string;
  warnings?: string[];
}

/** Assemble the resolver's public result from a scoring outcome. */
export function summarizeResolution(
  parsed: ParsedName,
  queries: string[],
  scored: { candidates: ScoredCandidate[]; supporting: Evidence[] },
  errors: string[] = [],
): ResolveResult {
  const result: ResolveResult = {
    email: null, confidence: "none", evidence: [], candidates: [], queries,
    supporting: scored.supporting.slice(0, 3),
    name: { firsts: parsed.display_firsts, surname: parsed.display_surname },
  };
  result.candidates = scored.candidates.slice(0, 3).map((c) => ({
    email: c.email, confidence: c.confidence, score: c.score, display_names: c.display_names, evidence: c.evidence.slice(0, 4),
  }));
  const top = scored.candidates[0];
  if (top) {
    result.confidence = top.confidence;
    const evidence = top.evidence.slice(0, 4);
    if (top.confidence === "high" || top.confidence === "medium") {
      result.email = top.email;
      if (scored.supporting.length && evidence.length < 4) evidence.push(scored.supporting[0]);
    }
    result.evidence = evidence;
  }
  if (errors.length && !scored.candidates.length) result.error = errors.slice(0, 3).join("; ");
  else if (errors.length) result.warnings = errors.slice(0, 3);
  return result;
}

/** Best-effort plain text from a Gmail format=full payload. */
export function bodyText(payload: Record<string, unknown> | null | undefined): string {
  const out: string[] = [];
  const walk = (part: unknown) => {
    if (!part || typeof part !== "object") return;
    const p = part as { mimeType?: string; body?: { data?: string }; parts?: unknown[] };
    const mime = p.mimeType ?? "";
    const data = p.body?.data;
    if (data && mime.startsWith("text/")) {
      let decoded = "";
      try {
        const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
        const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        decoded = new TextDecoder("utf-8").decode(bytes);
      } catch { decoded = ""; }
      if (mime === "text/html") decoded = htmlUnescape(decoded.replace(/<[^>]+>/g, " "));
      out.push(decoded);
    }
    for (const sub of p.parts ?? []) walk(sub);
  };
  walk(payload ?? {});
  return out.join(" ").replace(/\s+/g, " ");
}

/** YYYY-MM-DD from a Gmail message's Date header or internalDate. */
export function parseMessageDate(headers: Record<string, string>, internalDate?: string | number): string {
  const raw = headers.date ?? headers.Date;
  if (raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  }
  const ms = Number(internalDate ?? 0);
  if (ms) return new Date(ms).toISOString().slice(0, 10);
  return "";
}
