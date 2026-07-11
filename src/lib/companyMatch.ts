// Shared company-name normalization and matching used by both the dashboard
// and the agent-scan edge function (Deno port lives inline in agent-scan).
//
// Goal: every company is either an "Ashby client" or a "Slack-only client",
// driven by a persistent known-Ashby-clients set. Matching must be lenient
// enough to collapse "Listen Labs" <-> "Listenlabs", "Crosby" <-> "Crosby Legal",
// "Valon Tech" <-> "Valon Eng Ds", while keeping obviously different companies
// separate.

export const COMPANY_NOISE = new Set([
  "inc", "llc", "ltd", "co", "corp", "company",
  "labs", "lab", "ai", "io", "hq", "the", "a",
  "legal", "technologies", "tech", "research",
  "engineering", "engineers", "eng", "ds",
]);

const TRAILING_SUFFIXES = [
  "labs", "lab", "legal", "technologies", "tech", "research",
  "engineering", "engineers", "eng", "ds",
];

/** Split a name into normalized tokens with noise removed. */
export function companyTokens(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !COMPANY_NOISE.has(t));
}

/** Collapsed normalized key: e.g. "Valon Tech, Inc." -> "valon". */
export function normalizeCompany(s: string): string {
  return companyTokens(s).join("");
}

/** Build a small set of alias keys we'll cross-check between two names. */
export function companyAliases(s: string): Set<string> {
  const tokens = companyTokens(s);
  const aliases = new Set<string>();
  const collapsed = tokens.join("");
  if (collapsed) aliases.add(collapsed);
  if (tokens[0] && tokens[0].length >= 4) aliases.add(tokens[0]);
  if (tokens.length >= 2) aliases.add(tokens.slice(0, 2).join(""));

  // Single-token suffix peeling: "listenlabs" -> "listen", "crosbylegal" -> "crosby".
  if (tokens.length === 1) {
    const single = tokens[0];
    for (const suffix of TRAILING_SUFFIXES) {
      if (single.endsWith(suffix) && single.length - suffix.length >= 4) {
        aliases.add(single.slice(0, -suffix.length));
      }
    }
  }
  return aliases;
}

// Clients that are deliberately tracked as separate entities even though
// their names overlap with another client — e.g. "Anterior Vpe Cto" is a
// different hiring manager running a different search than "Anterior".
// Names here (normalized, lowercase, space-joined) only ever match
// themselves exactly, so an "Anterior" org can never swallow the
// "Anterior Vpe Cto" loop. Mirrors SEPARATE_CLIENTS in the desktop app's
// useMergedPipeline.ts / agent_runner.py.
export const SEPARATE_CLIENTS = new Set(["anterior vpe cto"]);

/** Lowercase alnum-tokenized key WITHOUT noise filtering, for exact-only names. */
function rawNameKey(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(" ");
}

/** True when two company names plausibly refer to the same company. */
export function companiesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aRaw = rawNameKey(a);
  const bRaw = rawNameKey(b);
  if (SEPARATE_CLIENTS.has(aRaw) || SEPARATE_CLIENTS.has(bRaw)) {
    return aRaw === bRaw;
  }
  const aAliases = companyAliases(a);
  const bAliases = companyAliases(b);
  for (const alias of aAliases) if (bAliases.has(alias)) return true;

  const aKey = normalizeCompany(a);
  const bKey = normalizeCompany(b);
  if (aKey && bKey) {
    const shorter = Math.min(aKey.length, bKey.length);
    if (shorter >= 5 && (aKey.startsWith(bKey) || bKey.startsWith(aKey))) return true;
  }

  const [aFirst] = companyTokens(a);
  const [bFirst] = companyTokens(b);
  return !!aFirst && aFirst === bFirst && aFirst.length >= 5;
}

/**
 * Decide whether a company name belongs to the Ashby pipeline, given the
 * authoritative set of Ashby client names harvested from past fetches.
 */
export function isAshbyCompany(
  companyName: string,
  ashbyClients: Iterable<string>,
): boolean {
  if (!companyName) return false;
  for (const client of ashbyClients) {
    if (companiesMatch(companyName, client)) return true;
  }
  return false;
}
