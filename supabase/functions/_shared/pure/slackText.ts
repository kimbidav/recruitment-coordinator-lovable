// Slack message parsing shared by the sync, the events receiver and the
// Add-to-Ashby shortcut. Ported from the local coordinator
// (slack_scanner._extract_linkedin_url, change_detector.*, api_server._clean_slack_text
// and friends) so Compass and the desktop app agree on what a submission is.
// Pure: no Deno/browser APIs. Keep in sync with recruitment_coordinator_agent.

export const LINKEDIN_RE = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+/i;

/** First LinkedIn profile URL in a message, looking inside <url|label> markup too. */
export function extractLinkedinUrl(text: string): string | null {
  const cleaned = (text || "").replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g, "$1");
  const m = cleaned.match(LINKEDIN_RE);
  return m ? m[0] : null;
}

/** Canonical LinkedIn key: strip protocol/www/query/trailing slash. */
export function normalizeLinkedin(url: string | null | undefined): string {
  let u = (url || "").trim().toLowerCase();
  u = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
  return u.split("?")[0].replace(/\/+$/, "");
}

/**
 * Candidate name from a submission message. DK's format is
 *   @mention intro text
 *   :emoji: *<linkedin_url|Candidate Name>* – description
 * so the LinkedIn link's label is the name; falls back to "Name – description".
 */
export function extractCandidateName(text: string): string {
  const t = text || "";
  const link = t.match(/<https?:\/\/(?:www\.)?linkedin\.com\/in\/[^|>]+\|([^>]+)>/i);
  if (link) {
    const name = link[1].trim().replace(/^\*+|\*+$/g, "").trim();
    if (name && name.length < 60) return name;
  }
  const cleaned = t.replace(/<[^|>]+\|([^>]+)>/g, "$1").replace(/<[^>]+>/g, "");
  for (const rawLine of cleaned.trim().split("\n")) {
    let line = rawLine.trim();
    line = line.replace(/^:[^:]+:\s*/, "").trim();
    line = line.replace(/^\*+|\*+$/g, "").trim();
    const m = line.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-zA-Z\-']+)+)\s*[–—-]/);
    if (m) return m[1].trim();
  }
  return "";
}

const CHANNEL_PREFIXES = ["candidatelabs-", "candidate-labs-", "ext-", "external-", "clientchat-"];
const CHANNEL_SUFFIXES = [
  "-engineers", "-engineering", "-eng", "-hiring", "-fwd", "-forward", "-submissions",
  "-recruiting", "-general", "-onboarding", "-fde", "-director-eng", "-gtm-engineer",
  "-ai-engineer", "-customer-eng",
];

function titleCase(s: string): string {
  return s.split(" ").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Display-friendly client name from a Slack channel name.
 *   candidatelabs-agave-engineering -> Agave
 *   ext-candidatelabs-prometheus-engineering -> Prometheus (prefixes stack)
 *   supio-candidate-labs-recruiting -> Supio (client-created naming)
 */
export function channelToClientName(channelName: string): string {
  let name = (channelName || "").toLowerCase();
  name = name.replace(/(?:^|-)candidate-?labs(?=-|$)/g, "").replace(/^-+|-+$/g, "");
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of CHANNEL_PREFIXES) {
      if (name.startsWith(p)) { name = name.slice(p.length); changed = true; }
    }
  }
  changed = true;
  while (changed) {
    changed = false;
    for (const s of CHANNEL_SUFFIXES) {
      if (name.endsWith(s)) { name = name.slice(0, -s.length); changed = true; }
    }
  }
  const result = titleCase(name.replace(/-/g, " ").trim());
  return result || channelName;
}

// CL's own internal channels that Slack marks ext-shared: recruiters trading
// candidates with each other, not client deal flow.
export const DEFAULT_CHANNEL_EXCLUDE = ["eng-candidate-review", "eng-recruiting-general"];

/** Every external (Slack Connect) channel is a client channel, plus any channel carrying the agency name. */
export function channelQualifies(
  ch: { name?: string; is_ext_shared?: boolean; is_archived?: boolean },
  exclude: Iterable<string> = DEFAULT_CHANNEL_EXCLUDE,
): boolean {
  const name = (ch.name || "").toLowerCase();
  if (!name || ch.is_archived) return false;
  for (const ex of exclude) if (name === ex.toLowerCase()) return false;
  return ch.is_ext_shared === true || name.replace(/[-_]/g, "").includes("candidatelabs");
}

/**
 * Slack markup -> plain text for a note the CLIENT reads in Ashby: mentions
 * dropped, <url|label> -> "label (url)", entities unescaped, and Slack-only
 * syntax (:emoji_codes:, *bold*, _italic_) removed because it renders literally.
 */
export function cleanSlackText(text: string): string {
  let t = text || "";
  t = t.replace(/<@[A-Z0-9]+>/g, "");
  t = t.replace(/<([^|>]+)\|([^>]+)>/g, "$2 ($1)");
  t = t.replace(/<([^>]+)>/g, "$1");
  t = t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  t = t.replace(/(?<![\w:/]):[a-z0-9+-][a-z0-9_+-]*:(?::skin-tone-\d:)?(?![\w/])/g, "");
  t = t.replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, "$1");
  t = t.replace(/(?<![\w/])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w/])/g, "$1");
  t = t.replace(/(?<=\S)[ \t]{2,}/g, " ");
  t = t.replace(/^ (?=\S)/gm, "");
  t = t.replace(/[ \t]+\n/g, "\n");
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

export interface ThreadMessage { user?: string; text?: string }

/** One cleaned string per message by the thread's author (the parent plus their own replies). */
export function noteParts(messages: ThreadMessage[]): string[] {
  if (!messages.length) return [];
  const author = messages[0].user;
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.user !== author) continue;
    const text = cleanSlackText(msg.text || "").trim();
    if (text) parts.push(text);
  }
  return parts;
}

/** The write-up as one string: parent + the author's own replies, blank-line separated. */
export function assembleWriteup(messages: ThreadMessage[]): string {
  return noteParts(messages).join("\n\n");
}
