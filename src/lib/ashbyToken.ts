// Parsing/validation for a pasted Ashby session token. Shared by the team
// Reconnect dialog (AshbyFetchButton) and the per-recruiter Connect Ashby
// step (AshbyUserConnect). Accepts the bare value, a whole Cookie header, or
// a copied DevTools row.
export function normalizeTokenInput(raw: string): string {
  let v = raw.trim();
  // Strip surrounding quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  // If they pasted a whole "cookie:" header, try to extract the token
  const cookieHeaderMatch = v.match(/ashby_session_token\s*=\s*([^;\s]+)/i);
  if (cookieHeaderMatch) v = cookieHeaderMatch[1];
  // If they copied the DevTools row "ashby_session_token<TAB>value..."
  if (v.toLowerCase().startsWith("ashby_session_token")) {
    const parts = v.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) v = parts[1];
  }
  return v.trim();
}

export function validateToken(v: string): { valid: boolean; hint: string | null } {
  if (!v) return { valid: false, hint: null };
  if (v.length < 20) return { valid: false, hint: "Token looks too short" };
  if (/\s/.test(v)) return { valid: false, hint: "Token shouldn't contain spaces" };
  if (v.includes("=")) return { valid: false, hint: "Looks like you pasted name=value — paste only the value" };
  return { valid: true, hint: null };
}
