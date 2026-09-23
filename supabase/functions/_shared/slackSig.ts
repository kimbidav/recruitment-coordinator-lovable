// Slack request-signature verification, shared by slack-events and
// slack-interactions. Lifted from slack-events/index.ts unchanged in behavior.

export async function verifySlackSignature(req: Request, rawBody: string, secret = Deno.env.get("SLACK_SIGNING_SECRET")): Promise<boolean> {
  if (!secret) {
    console.error("SLACK_SIGNING_SECRET not configured — rejecting request");
    return false;
  }
  const ts = req.headers.get("x-slack-request-timestamp") ?? "";
  const sig = req.headers.get("x-slack-signature") ?? "";
  if (!ts || !sig) return false;
  // Replay-protection window per Slack docs.
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${rawBody}`));
  const expected = "v0=" + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
