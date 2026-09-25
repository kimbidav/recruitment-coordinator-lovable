import { useState } from "react";
import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { normalizeTokenInput, validateToken } from "@/lib/ashbyToken";
import { useAshbyUserSession } from "@/hooks/useAshbyUserSession";

const ERROR_COPY: Record<string, string> = {
  identity_mismatch:
    "That Ashby login belongs to someone else. Sign in to Ashby as yourself, copy the value again, and paste it here. Nothing was saved.",
  cookie_not_authenticated:
    "Ashby didn't accept that value. Make sure you're signed in to Ashby, then copy ashby_session_token again. It changes every time you sign in.",
  cookie_missing_token: "That isn't the ashby_session_token value. Copy the Value column of that row, not its name.",
  identity_unverifiable:
    "Ashby didn't say which account this login belongs to, so it couldn't be matched to you. Nothing was saved. Try signing out of Ashby and back in.",
  extractor_unreachable: "The Ashby connector isn't answering right now. Try again in a minute.",
};

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function Num({ n }: { n: number }) {
  return (
    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
      {n}
    </span>
  );
}

/**
 * Connect the recruiter's OWN Ashby login. Uploads from Slack run under it,
 * so they're credited to the recruiter and only reach clients they can see.
 * The connector checks the login's account email against the signed-in
 * email before storing anything.
 */
export function AshbyUserConnect({ onConnected }: { onConnected?: () => void }) {
  const { seed } = useAshbyUserSession();
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleaned = normalizeTokenInput(raw);
  const validation = validateToken(cleaned);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await seed(cleaned);
      if (res.ok === false) {
        const failed: { error: string; detail: string | null } = res;
        setError(ERROR_COPY[failed.error] ?? failed.detail ?? `Couldn't connect Ashby (${failed.error}).`);
        return;
      }
      toast.success(`Ashby connected. ${res.org_count} client org${res.org_count === 1 ? "" : "s"} visible.`);
      setRaw("");
      onConnected?.();
    } finally {
      setBusy(false);
    }
  };

  const kbd = "rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground";

  return (
    <div className="space-y-4">
      <ol className="space-y-3 text-sm text-foreground">
        <li className="flex gap-3">
          <Num n={1} />
          <div className="space-y-2">
            <p>Open Ashby in a new tab and make sure you're signed in as yourself.</p>
            <Button asChild size="sm" variant="outline" className="gap-1.5">
              <a href="https://app.ashbyhq.com/" target="_blank" rel="noopener noreferrer">
                Open Ashby <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          </div>
        </li>
        <li className="flex gap-3">
          <Num n={2} />
          <p>
            On the Ashby tab, press <kbd className={kbd}>{isMac ? "Option ⌥ + Cmd ⌘ + I" : "Ctrl + Shift + I"}</kbd>. A
            developer panel opens on the side or bottom of the window.
          </p>
        </li>
        <li className="flex gap-3">
          <Num n={3} />
          <p>
            At the top of that panel, click <b>Application</b>. If you don't see it, click <b>»</b> to show more tabs.
            (In Firefox it's called <b>Storage</b>.)
          </p>
        </li>
        <li className="flex gap-3">
          <Num n={4} />
          <p>
            In the panel's left column, open <b>Cookies</b> and click <b>https://app.ashbyhq.com</b>.
          </p>
        </li>
        <li className="flex gap-3">
          <Num n={5} />
          <p>
            Find the row named <code className={kbd}>ashby_session_token</code>. Double-click its <b>Value</b> and copy it
            with <kbd className={kbd}>{isMac ? "Cmd ⌘ + C" : "Ctrl + C"}</kbd>.
          </p>
        </li>
        <li className="flex gap-3">
          <Num n={6} />
          <div className="w-full min-w-0 space-y-2">
            <label htmlFor="ashby-token" className="block">
              Paste it here and press <b>Connect Ashby</b>.
            </label>
            <Textarea
              id="ashby-token"
              rows={3}
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setError(null);
              }}
              placeholder="Paste the ashby_session_token value"
              disabled={busy}
              className="font-mono text-xs"
            />
            {validation.hint && <p className="text-xs text-amber-700 dark:text-amber-400">{validation.hint}</p>}
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button onClick={() => void submit()} disabled={busy || !validation.valid} className="gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              {busy ? "Checking with Ashby…" : "Connect Ashby"}
            </Button>
          </div>
        </li>
      </ol>
      <p className="text-xs text-muted-foreground">
        Ashby signs everyone out about once a week. You'll get a reminder here and in Slack; just repeat these steps. It
        takes about 30 seconds.
      </p>
    </div>
  );
}
