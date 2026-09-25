// Per-user recruiter identity: maps the org-shared Ashby snapshot's
// credited_to values onto the signed-in user via their saved aliases
// (agent_settings.recruiter_aliases, captured at onboarding).

export function normalizePersonName(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Does this credited_to belong to the user with these aliases?
 *  Empty/unknown credited_to passes — same benefit-of-the-doubt the desktop
 *  app gives ("unknown" and "" are in its DK_NAMES set). */
export function creditedToMatchesAliases(creditedTo: string | null | undefined, aliases: string[]): boolean {
  const credited = normalizePersonName(creditedTo ?? "");
  if (!credited || credited === "unknown") return true;
  return aliases.some((a) => normalizePersonName(a) === credited);
}

/** Suggest which of the org's credited_to values look like this user, from
 *  their email local-part (e.g. dkimball → "David Kimball"). */
export function suggestAliasesFromEmail(email: string, creditedToValues: string[]): string[] {
  const local = (email.split("@")[0] || "").toLowerCase();
  if (!local) return [];
  const parts = local.split(/[._\-+]/).filter(Boolean);
  const out: string[] = [];
  for (const value of creditedToValues) {
    const norm = normalizePersonName(value);
    if (!norm) continue;
    const tokens = norm.split(" ");
    const matches =
      // "david.kimball" → both tokens present
      (parts.length > 1 && parts.every((p) => tokens.includes(p))) ||
      // "dkimball" → first initial + last name
      (parts.length === 1 &&
        tokens.length >= 2 &&
        local.length > 2 &&
        tokens[0].startsWith(local[0]) &&
        local.slice(1) === tokens[tokens.length - 1]) ||
      // exact single-token match ("david")
      tokens.includes(local);
    if (matches) out.push(value);
  }
  return out;
}

/**
 * Is this row the signed-in recruiter's? The Ashby credited-to EMAIL is the
 * strongest signal (the snapshot carries it for every row fetched since
 * v2), so no setup is needed. Rows without an email fall back to saved
 * aliases, then to names derived from the login email (dkimball → "David
 * Kimball"). Empty/unknown credit passes, as before.
 */
export function isMine(
  row: { credited_to?: string | null; credited_to_email?: string | null },
  userEmail: string | null | undefined,
  aliases: string[],
): boolean {
  const email = (row.credited_to_email ?? "").trim().toLowerCase();
  const me = (userEmail ?? "").trim().toLowerCase();
  if (email && me) return email === me;
  if (aliases.length > 0) return creditedToMatchesAliases(row.credited_to, aliases);
  const credited = row.credited_to ?? "";
  if (!normalizePersonName(credited) || normalizePersonName(credited) === "unknown") return true;
  return me ? suggestAliasesFromEmail(me, [credited]).length > 0 : true;
}
