import { useEffect, useRef, useState } from "react";
import { ExternalLink, KeyRound, Loader2, Puzzle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { normalizeTokenInput, validateToken } from "@/lib/ashbyToken";
import { useAshbyUserSession } from "@/hooks/useAshbyUserSession";

const ERROR_COPY: Record<string, string> = {
  identity_mismatch: "That Ashby login belongs to a different account than yours. Sign in to Ashby as yourself and try again — nothing was stored.",
  cookie_not_authenticated: "Ashby rejected that token. Make sure you're signed in to Ashby and copied the current value.",
  cookie_missing_token: "That doesn't look like an ashby_session_token value.",
  identity_unverifiable: "Ashby didn't report which account this login belongs to, so it can't be matched to you. Nothing was stored.",
  extractor_unreachable: "The Ashby extractor isn't answering right now. Try again in a minute.",
};

/**
 * "Connect Ashby (yours)". Uploads from Slack run under THIS login, so it
 * must be the recruiter's own: the extractor checks the token's account
 * email against the signed-in email before storing anything.
 *
 * Two ways in: the Chrome extension (one click; it reads the HttpOnly
 * cookie a page cannot) or a DevTools paste (the same steps as the team
 * Reconnect dialog).
 */
export function AshbyUserConnect({ onChanged }: { onChanged?: () => void }) {
  const { session, seed, disconnect, refresh } = useAshbyUserSession();
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [extensionReady, setExtensionReady] = useState(false);
  const pending = useRef<string | null>(null);

  // The extension's content script announces itself and answers cookie requests.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== window.location.origin) return;
      if (e.data?.type === "compass-extension-ready") setExtensionReady(true);
      if (e.data?.type === "compass-ashby-cookie" && e.data.requestId === pending.current) {
        pending.current = null;
        if (!e.data.ok || !e.data.value) {
          setBusy(false);
          toast.error("No Ashby login found in this browser. Sign in at app.ashbyhq.com first, then try again.");
          return;
        }
        void submit(String(e.data.value));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (token: string) => {
    setBusy(true);
    try {
      const res = await seed(token);
      if (res.ok === false) {
        const failed: { error: string; detail: string | null } = res;
        toast.error(ERROR_COPY[failed.error] ?? failed.detail ?? `Couldn't connect Ashby (${failed.error}).`);
        return;
      }
      toast.success(`Ashby connected — ${res.org_count} client org${res.org_count === 1 ? "" : "s"} visible.`);
      setOpen(false);
      setRaw("");
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const viaExtension = () => {
    const requestId = crypto.randomUUID();
    pending.current = requestId;
    setBusy(true);
    window.postMessage({ type: "compass-request-ashby-cookie", requestId }, window.location.origin);
    setTimeout(() => { if (pending.current === requestId) { pending.current = null; setBusy(false); toast.error("The extension didn't answer. Is it installed and enabled?"); } }, 5000);
  };

  const cleaned = normalizeTokenInput(raw);
  const validation = validateToken(cleaned);
  const healthy = session.status === "healthy";
  const expiresSoon = session.expires_estimate_at ? new Date(session.expires_estimate_at).getTime() - Date.now() < 24 * 3600_000 : false;

  return (
    <div className="space-y-2">
      {healthy ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" />
          <span>
            Connected as <span className="font-medium text-foreground">{session.email}</span>
            {session.org_count ? ` · ${session.org_count} client orgs` : ""}
            {session.expires_estimate_at ? ` · expires around ${new Date(session.expires_estimate_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}
          </span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setOpen(true)}>Reconnect</Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void refresh(true)}>Check</Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-destructive" onClick={() => void disconnect().then(onChanged)}>Disconnect</Button>
          {expiresSoon && <span className="text-amber-600">Expires soon — reconnect when convenient.</span>}
        </div>
      ) : (
        <Button size="sm" variant={session.status === "expired" ? "default" : "outline"} className="gap-2" onClick={() => setOpen(true)}>
          <KeyRound className="h-4 w-4" />
          {session.status === "expired" ? "Reconnect Ashby" : "Connect Ashby"}
        </Button>
      )}
      {session.status === "expired" && !healthy && (
        <p className="text-xs text-amber-600">Your Ashby login expired{session.last_error ? ` (${session.last_error})` : ""}. Uploads from Slack won't work until you reconnect.</p>
      )}

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Connect your Ashby login</DialogTitle>
            <DialogDescription>
              Uploads you make from Slack run under <span className="font-medium">your</span> Ashby account, so they're credited to you and only reach clients you have access to.
              Ashby logins last about a week, so you'll do this again occasionally.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-md border border-border p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium"><Puzzle className="h-4 w-4" /> One click, with the Chrome extension</div>
            <p className="text-xs text-muted-foreground">Sign in to Ashby in this browser, then click below. The extension reads your Ashby login and hands it to this page — nothing is stored in the extension.</p>
            <Button size="sm" onClick={viaExtension} disabled={busy || !extensionReady} className="gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Puzzle className="h-4 w-4" />}
              {extensionReady ? "Connect with the extension" : "Extension not detected"}
            </Button>
            {!extensionReady && <p className="text-xs text-muted-foreground">Ask for the “Candidate Compass — Connect Ashby” extension, or paste the token below instead.</p>}
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium">Or paste the token from DevTools</div>
            <ol className="text-xs text-muted-foreground list-decimal pl-4 space-y-1">
              <li>
                Open <button type="button" className="underline inline-flex items-center gap-1" onClick={() => window.open("https://app.ashbyhq.com/", "_blank", "noopener")}>app.ashbyhq.com <ExternalLink className="h-3 w-3" /></button> and make sure you're signed in as yourself.
              </li>
              <li>Open DevTools (⌥⌘I on Mac, Ctrl+Shift+I elsewhere) → Application (Firefox: Storage) → Cookies → https://app.ashbyhq.com.</li>
              <li>Double-click the Value of <code className="rounded bg-muted px-1 font-mono">ashby_session_token</code>, copy it, paste below.</li>
            </ol>
            <Textarea rows={3} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Paste your ashby_session_token value here…" disabled={busy} className="font-mono text-xs" />
            {validation.hint && <p className="text-xs text-amber-600">{validation.hint}</p>}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void submit(cleaned)} disabled={busy || !validation.valid} className="gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
