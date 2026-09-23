// Candidate identity across sources. Slack and Ashby routinely disagree on a
// person's display name ("Dan Clark" vs "Daniel Clark", "Zhaohan (Robert) Hu"
// vs "Robert (Zhaohan) Hu", "sai" vs "Sai Xiao"). Ported from
// agent_runner._same_candidate_name; identity is person-level, so every join
// site must ALSO require a company match.

/**
 * True when every token of the shorter name matches into the longer one.
 * Tokens are alphanumeric only (so parenthesized nicknames compare regardless
 * of which name carries the parens) and match exactly, except the FIRST token
 * of each name (the given name) may match by a >=3-char prefix. Surnames stay
 * exact: "Dan Clarkson" never collapses into "Daniel Clark".
 */
export function sameCandidateName(a: string, b: string): boolean {
  const an = (a || "").trim().toLowerCase();
  const bn = (b || "").trim().toLowerCase();
  if (!an || !bn) return false;
  if (an === bn) return true;
  const at = an.match(/[a-z0-9]+/g) || [];
  const bt = bn.match(/[a-z0-9]+/g) || [];
  if (!at.length || !bt.length) return false;
  const firstPrefix = (x: string, y: string) =>
    (x.length >= 3 && y.startsWith(x)) || (y.length >= 3 && x.startsWith(y));
  const [shorter, longer] = at.length <= bt.length ? [at, bt] : [bt, at];
  return shorter.every((s, i) =>
    longer.some((l, j) => s === l || (i === 0 && j === 0 && firstPrefix(s, l))),
  );
}
