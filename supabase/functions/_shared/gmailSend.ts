// Send a plain-text email as the connected Gmail user. Shared by
// gmail-helper (ad-hoc compose) and agent-act (review-queue approval).

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildRfc2822(args: { from: string; to: string; subject: string; body: string }): string {
  const encodedSubject = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(args.subject)))}?=`;
  return [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    args.body,
  ].join("\r\n");
}

export async function sendGmail(accessToken: string, args: { from: string; to: string; subject: string; body: string }): Promise<{ id: string }> {
  const raw = base64UrlEncode(buildRfc2822(args));
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.id) throw new Error(`Gmail send failed: ${JSON.stringify(json).slice(0, 300)}`);
  return { id: json.id as string };
}
