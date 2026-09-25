import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useOnboardingStatus } from "@/hooks/useOnboardingStatus";
import { useAshbyUserSession } from "@/hooks/useAshbyUserSession";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight, Check, ExternalLink, Loader2, LogOut, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { AshbyUserConnect } from "@/components/AshbyUserConnect";
import { AshbyFetchButton } from "@/components/AshbyFetchButton";
import { PostSignInCalendarPrompt } from "@/components/PostSignInCalendarPrompt";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const ONBOARDING_DISMISSED_KEY = "onboardingDismissed";
const PENDING_ONBOARDING_KEY = "pendingOnboarding";

type StepKey = "google" | "slack" | "ashby" | "sync" | "done";
const STEPS: { key: Exclude<StepKey, "done">; label: string }[] = [
  { key: "google", label: "Google" },
  { key: "slack", label: "Slack" },
  { key: "ashby", label: "Your Ashby" },
  { key: "sync", label: "Sync" },
];
const SYNC_FRESH_MS = 24 * 3600 * 1000;

function Instruction({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
        {n}
      </span>
      <div className="min-w-0">{children}</div>
    </li>
  );
}

function Notice({ tone, children }: { tone: "warn" | "ok"; children: React.ReactNode }) {
  return (
    <p
      className={cn(
        "rounded-md px-3 py-2 text-sm",
        tone === "warn" && "bg-amber-500/10 text-amber-800 dark:text-amber-300",
        tone === "ok" && "bg-primary/10 text-foreground",
      )}
    >
      {children}
    </p>
  );
}

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}

const Onboarding = () => {
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = useOnboardingStatus();
  const ashby = useAshbyUserSession();
  const [busy, setBusy] = useState<StepKey | null>(null);
  const [slackTabOpened, setSlackTabOpened] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [teamStatus, setTeamStatus] = useState<string | null>(null);
  const [syncLoaded, setSyncLoaded] = useState(false);

  const loadSyncState = useCallback(async () => {
    const [{ data: health }, { data: conn }] = await Promise.all([
      supabase.from("ashby_org_health").select("checked_at").eq("id", 1).maybeSingle(),
      supabase.from("ashby_connection").select("status").eq("id", 1).maybeSingle(),
    ]);
    setLastSyncAt((health as { checked_at?: string } | null)?.checked_at ?? null);
    setTeamStatus((conn as { status?: string } | null)?.status ?? null);
    setSyncLoaded(true);
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([status.refresh(), ashby.refresh(), loadSyncState()]);
  }, [status, ashby, loadSyncState]);

  useEffect(() => {
    document.title = "Set up · Candidate Compass";
    void loadSyncState();
  }, [loadSyncState]);

  // Slack connects in another tab: re-check when this tab regains focus, and
  // every few seconds while we wait on it.
  useEffect(() => {
    const onFocus = () => void refreshAll();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refreshAll]);
  useEffect(() => {
    if (!slackTabOpened || status.slackReady) return;
    const t = setInterval(() => void status.refresh(), 4000);
    return () => clearInterval(t);
  }, [slackTabOpened, status]);

  const done: Record<Exclude<StepKey, "done">, boolean> = useMemo(
    () => ({
      google: status.googleReady,
      slack: status.slackReady,
      ashby: ashby.session.status === "healthy",
      sync: !!lastSyncAt && Date.now() - Date.parse(lastSyncAt) < SYNC_FRESH_MS,
    }),
    [status.googleReady, status.slackReady, ashby.session.status, lastSyncAt],
  );
  const firstOpen: StepKey = STEPS.find((s) => !done[s.key])?.key ?? "done";
  const requested = params.get("step") as StepKey | null;
  const step: StepKey = requested && (requested === "done" || STEPS.some((s) => s.key === requested)) ? requested : firstOpen;
  const index = STEPS.findIndex((s) => s.key === step);

  const go = (next: StepKey) => {
    setParams(next === firstOpen ? {} : { step: next }, { replace: false });
    window.scrollTo({ top: 0 });
  };
  const nextOf = (k: StepKey): StepKey => {
    const i = STEPS.findIndex((s) => s.key === k);
    return i >= 0 && i < STEPS.length - 1 ? STEPS[i + 1].key : "done";
  };

  if (authLoading || status.loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!user) return <Navigate to="/auth" replace />;

  const connectGoogle = async () => {
    setBusy("google");
    try {
      const { data, error } = await supabase.functions.invoke("google-calendar-connect", {
        body: { redirect_uri: `${window.location.origin}/google-calendar/callback` },
      });
      if (error || !data?.url) {
        toast.error(`Couldn't start Google sign-in: ${error?.message || data?.error || "no link returned"}. Try again.`);
        return;
      }
      try {
        sessionStorage.setItem("googleReturnTo", "/onboarding");
      } catch {
        /* storage unavailable: you'll land on the dashboard instead */
      }
      window.location.href = data.url;
    } finally {
      setBusy(null);
    }
  };

  const connectSlack = async () => {
    setBusy("slack");
    try {
      const { data, error } = await supabase.functions.invoke("slack-connect", {
        body: { redirect_uri: `${window.location.origin}/slack/callback` },
      });
      if (error || !data?.url) {
        toast.error(`Couldn't start Slack sign-in: ${error?.message || data?.error || "no link returned"}. Try again.`);
        return;
      }
      // Slack's page refuses to load inside frames, so it opens in a new tab.
      const w = window.open(data.url, "_blank");
      if (!w) {
        toast.error("Your browser blocked the Slack tab. Allow pop-ups for this site and press Connect Slack again.");
        return;
      }
      setSlackTabOpened(true);
    } finally {
      setBusy(null);
    }
  };

  const finish = () => {
    try {
      sessionStorage.removeItem(PENDING_ONBOARDING_KEY);
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
    } catch {
      /* ignore */
    }
    navigate("/", { replace: true });
  };

  // ── Footer: Back · Continue ──────────────────────────────────────────────
  const Footer = ({ canContinue, continueLabel }: { canContinue: boolean; continueLabel?: string }) => (
    <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
      {index > 0 ? (
        <Button variant="ghost" onClick={() => go(STEPS[index - 1].key)} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-2">
        {!canContinue && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => go(nextOf(step))}>
            Skip for now
          </Button>
        )}
        <Button onClick={() => go(nextOf(step))} disabled={!canContinue} className="gap-1.5">
          {continueLabel ?? "Continue"} <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      <PostSignInCalendarPrompt />

      <header className="border-b border-border bg-card">
        <div className="container flex items-center justify-between py-4">
          <div className="flex items-center gap-2">
            <div className="rounded bg-primary p-1.5">
              <Users className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="text-sm font-semibold">Candidate Compass</span>
          </div>
          <Button variant="ghost" size="sm" onClick={signOut} className="gap-2" title={user.email ?? "Sign out"}>
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </header>

      <main className="container max-w-xl space-y-6 py-10">
        {/* ── Progress: four labelled dots ──────────────────────────────── */}
        <nav aria-label="Setup progress">
          <ol className="grid grid-cols-4 gap-2">
            {STEPS.map((s, i) => {
              const isCurrent = s.key === step;
              const isDone = done[s.key];
              return (
                <li key={s.key}>
                  <button
                    type="button"
                    onClick={() => go(s.key)}
                    className="group flex w-full flex-col items-center gap-1.5 rounded-md py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-current={isCurrent ? "step" : undefined}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-full rounded-full",
                        isDone ? "bg-primary" : isCurrent ? "bg-primary/40" : "bg-muted",
                      )}
                    />
                    <span
                      className={cn(
                        "flex items-center gap-1 text-xs",
                        isCurrent ? "font-semibold text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {isDone && <Check className="h-3 w-3 text-primary" />}
                      {i + 1}. {s.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <section className="space-y-5 rounded-xl border border-border bg-card p-6 shadow-sm">
          {/* ── 1. Google ─────────────────────────────────────────────── */}
          {step === "google" && (
            <>
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Step 1 of 4</p>
                <h1 className="text-xl font-semibold text-foreground">Connect Google</h1>
                <p className="text-sm text-muted-foreground">
                  Compass reads your Gmail to find a candidate's email address and puts interview reminders on your
                  calendar. It only sends email when you press Send.
                </p>
              </div>
              {done.google ? (
                <Notice tone="ok">Connected as {status.googleEmail ?? user.email}.</Notice>
              ) : (
                <>
                  {status.googleConnected && (
                    <Notice tone="warn">
                      Google is connected but missing Gmail or Calendar permission. Connect again and leave every box
                      ticked.
                    </Notice>
                  )}
                  <ol className="space-y-2 text-sm text-foreground">
                    <Instruction n={1}>
                      Press <b>Connect Google</b>.
                    </Instruction>
                    <Instruction n={2}>
                      Choose your <b>@candidatelabs.com</b> account.
                    </Instruction>
                    <Instruction n={3}>
                      Leave every permission ticked and press <b>Continue</b>. You come straight back here.
                    </Instruction>
                  </ol>
                  <Button onClick={() => void connectGoogle()} disabled={busy === "google"} className="gap-2">
                    {busy === "google" && <Loader2 className="h-4 w-4 animate-spin" />}
                    Connect Google
                  </Button>
                </>
              )}
              <Footer canContinue={done.google} />
            </>
          )}

          {/* ── 2. Slack ──────────────────────────────────────────────── */}
          {step === "slack" && (
            <>
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Step 2 of 4</p>
                <h1 className="text-xl font-semibold text-foreground">Connect Slack</h1>
                <p className="text-sm text-muted-foreground">
                  This lets the <b>Ashby Uploader</b> app read your own intro posts and the resume in the thread, and send
                  you a private message when an upload is done. It never posts in client channels.
                </p>
              </div>
              {done.slack ? (
                <Notice tone="ok">Connected to {status.slackTeamName ?? "Slack"}.</Notice>
              ) : (
                <>
                  {status.slackConnected && (
                    <Notice tone="warn">
                      Slack is connected with older permissions. Connect again so Add to Ashby can read resumes and
                      message you.
                    </Notice>
                  )}
                  <ol className="space-y-2 text-sm text-foreground">
                    <Instruction n={1}>
                      Press <b>Connect Slack</b>. Slack opens in a new tab.
                    </Instruction>
                    <Instruction n={2}>
                      Check the workspace at the top right says <b>Candidate Labs</b>, then press <b>Allow</b>.
                    </Instruction>
                    <Instruction n={3}>Close that tab and come back here. This page updates by itself.</Instruction>
                  </ol>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button onClick={() => void connectSlack()} disabled={busy === "slack"} className="gap-2">
                      {busy === "slack" && <Loader2 className="h-4 w-4 animate-spin" />}
                      Connect Slack
                    </Button>
                    {slackTabOpened && (
                      <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for Slack…
                      </span>
                    )}
                  </div>
                </>
              )}
              <Footer canContinue={done.slack} />
            </>
          )}

          {/* ── 3. Your Ashby ─────────────────────────────────────────── */}
          {step === "ashby" && (
            <>
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Step 3 of 4</p>
                <h1 className="text-xl font-semibold text-foreground">
                  {ashby.session.status === "expired" ? "Reconnect your Ashby" : "Connect your Ashby"}
                </h1>
                <p className="text-sm text-muted-foreground">
                  Uploads from Slack run under <b>your own</b> Ashby login, so candidates are credited to you and only
                  reach clients you have access to. You'll copy one value from Ashby and paste it here.
                </p>
              </div>
              {done.ashby ? (
                <>
                  <Notice tone="ok">
                    Connected as {ashby.session.email ?? user.email}
                    {ashby.session.org_count ? ` · ${ashby.session.org_count} client orgs` : ""}
                    {ashby.session.expires_estimate_at
                      ? ` · reconnect around ${new Date(ashby.session.expires_estimate_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                      : ""}
                    .
                  </Notice>
                  <details className="text-sm">
                    <summary className="cursor-pointer text-muted-foreground">Connect again with a new login</summary>
                    <div className="pt-4">
                      <AshbyUserConnect onConnected={() => void refreshAll()} />
                    </div>
                  </details>
                </>
              ) : (
                <>
                  {ashby.session.status === "expired" && (
                    <Notice tone="warn">
                      Your Ashby login expired, which happens about once a week. Uploads from Slack are paused until you
                      reconnect.
                    </Notice>
                  )}
                  <AshbyUserConnect onConnected={() => void refreshAll()} />
                </>
              )}
              <Footer canContinue={done.ashby} />
            </>
          )}

          {/* ── 4. Sync from Ashby ────────────────────────────────────── */}
          {step === "sync" && (
            <>
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Step 4 of 4</p>
                <h1 className="text-xl font-semibold text-foreground">Sync your pipeline from Ashby</h1>
                <p className="text-sm text-muted-foreground">
                  This loads every client's Ashby pipeline into your dashboard, so you can see where each of your
                  candidates stands. The whole team shares one sync.
                </p>
              </div>
              {done.sync ? (
                <Notice tone="ok">The pipeline was synced {timeAgo(lastSyncAt!)}. You're up to date.</Notice>
              ) : syncLoaded && teamStatus !== "healthy" ? (
                <Notice tone="warn">
                  The team's Ashby connection needs a fresh login first. Press <b>Reconnect Ashby</b> below and paste
                  the same <code className="font-mono text-xs">ashby_session_token</code> value you used in step 3.
                </Notice>
              ) : null}
              {!done.sync && (
                <ol className="space-y-2 text-sm text-foreground">
                  <Instruction n={1}>
                    Press <b>{teamStatus === "healthy" ? "Sync from Ashby" : "Reconnect Ashby"}</b>.
                  </Instruction>
                  <Instruction n={2}>
                    The sync takes about 15 minutes. It saves itself when it's done, so you can carry on or close the
                    page.
                  </Instruction>
                </ol>
              )}
              <div>
                <AshbyFetchButton
                  onSyncComplete={async () => {
                    await loadSyncState();
                  }}
                />
              </div>
              <Footer canContinue continueLabel={done.sync ? "Continue" : "Continue while it syncs"} />
            </>
          )}

          {/* ── Done: how to use it ───────────────────────────────────── */}
          {step === "done" && (
            <>
              <div className="space-y-1">
                <h1 className="text-xl font-semibold text-foreground">You're set up</h1>
                <p className="text-sm text-muted-foreground">
                  Here's how to put a candidate into a client's Ashby from Slack. Try it on your next intro post.
                </p>
              </div>
              <ol className="space-y-2 text-sm text-foreground">
                <Instruction n={1}>
                  Post your intro in the client's Slack channel as usual, with the candidate's LinkedIn link. Attach the
                  resume in the thread if you have it.
                </Instruction>
                <Instruction n={2}>
                  Hover over your post and click the three dots <b>⋮</b> (More actions) at its top right.
                </Instruction>
                <Instruction n={3}>
                  Choose <b>Add to Ashby</b> with <b>Ashby Uploader</b> next to it. Not in the list? Click{" "}
                  <b>More message shortcuts…</b>, type <b>Ashby</b>, and pick it there.
                </Instruction>
                <Instruction n={4}>
                  Check the form (client, role, email, resume, write-up) and press <b>Add to Ashby</b>. Nothing reaches
                  the client's Ashby until you do. You'll get a private message with the link.
                </Instruction>
              </ol>
              {STEPS.some((s) => !done[s.key]) && (
                <Notice tone="warn">
                  Some steps aren't finished yet:{" "}
                  {STEPS.filter((s) => !done[s.key])
                    .map((s) => s.label)
                    .join(", ")}
                  . Add to Ashby needs Slack and your Ashby connected.
                </Notice>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
                <Button variant="ghost" onClick={() => go("sync")} className="gap-1.5">
                  <ArrowLeft className="h-4 w-4" /> Back
                </Button>
                <div className="flex items-center gap-3">
                  <a
                    href="https://app.slack.com/client"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline"
                  >
                    Open Slack <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  <Button onClick={finish}>Go to the dashboard</Button>
                </div>
              </div>
            </>
          )}
        </section>

        <p className="text-center text-xs text-muted-foreground">
          Signed in as {user.email}.{" "}
          {step !== "done" && (
            <button type="button" onClick={finish} className="underline underline-offset-2 hover:text-foreground">
              Finish later
            </button>
          )}
        </p>
      </main>
    </div>
  );
};

export default Onboarding;
