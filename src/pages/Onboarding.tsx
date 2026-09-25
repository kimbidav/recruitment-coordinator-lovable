import { useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useOnboardingStatus } from "@/hooks/useOnboardingStatus";
import { useAshbyUserSession } from "@/hooks/useAshbyUserSession";
import { Button } from "@/components/ui/button";
import { Check, ExternalLink, Loader2, LogOut, Lock, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { AshbyUserConnect } from "@/components/AshbyUserConnect";
import { PostSignInCalendarPrompt } from "@/components/PostSignInCalendarPrompt";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const ONBOARDING_DISMISSED_KEY = "onboardingDismissed";
const PENDING_ONBOARDING_KEY = "pendingOnboarding";

type StepKey = "google" | "slack" | "ashby";
type StepState = "done" | "current" | "upcoming";

interface StepCardProps {
  n: number;
  title: string;
  state: StepState;
  /** One line shown when the step is done. */
  doneSummary?: React.ReactNode;
  /** Shown on an upcoming step. */
  waitingOn?: string;
  onRedo?: () => void;
  children?: React.ReactNode;
}

function StepCard({ n, title, state, doneSummary, waitingOn, onRedo, children }: StepCardProps) {
  return (
    <section
      aria-current={state === "current" ? "step" : undefined}
      className={cn(
        "rounded-xl border bg-card transition-colors",
        state === "current" ? "border-primary/40 shadow-sm" : "border-border",
        state === "upcoming" && "opacity-60",
      )}
    >
      <div className="flex items-center gap-3 px-5 py-4">
        <div
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
            state === "done" && "bg-primary text-primary-foreground",
            state === "current" && "bg-primary/10 text-primary ring-1 ring-primary/30",
            state === "upcoming" && "bg-muted text-muted-foreground",
          )}
        >
          {state === "done" ? <Check className="h-4 w-4" /> : state === "upcoming" ? <Lock className="h-3.5 w-3.5" /> : n}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Step {n} of 3</p>
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {state === "done" && doneSummary && <p className="mt-0.5 text-sm text-muted-foreground">{doneSummary}</p>}
          {state === "upcoming" && waitingOn && <p className="mt-0.5 text-sm text-muted-foreground">{waitingOn}</p>}
        </div>
        {state === "done" && onRedo && (
          <Button variant="ghost" size="sm" onClick={onRedo} className="shrink-0 text-xs">
            Redo
          </Button>
        )}
      </div>
      {state === "current" && <div className="border-t border-border px-5 py-5">{children}</div>}
    </section>
  );
}

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

const Onboarding = () => {
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const status = useOnboardingStatus();
  const ashby = useAshbyUserSession();
  const [redo, setRedo] = useState<StepKey | null>(null);
  const [busy, setBusy] = useState<StepKey | null>(null);
  const [slackTabOpened, setSlackTabOpened] = useState(false);

  const refreshAll = useCallback(async () => {
    await Promise.all([status.refresh(), ashby.refresh()]);
  }, [status, ashby]);

  useEffect(() => {
    document.title = "Set up · Candidate Compass";
    // /onboarding?step=ashby comes from the Slack "Reconnect Ashby" button
    // and the expiry banner: open the Ashby step directly.
    if (new URLSearchParams(window.location.search).get("step") === "ashby") setRedo("ashby");
  }, []);

  // Slack connects in another tab. Re-check when this tab regains focus,
  // and every few seconds while we're waiting on it.
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

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!user) return <Navigate to="/auth" replace />;

  const googleDone = status.googleReady;
  const slackDone = status.slackReady;
  const ashbyDone = ashby.session.status === "healthy";
  const ashbyExpired = ashby.session.status === "expired";

  const order: StepKey[] = ["google", "slack", "ashby"];
  const doneMap: Record<StepKey, boolean> = { google: googleDone, slack: slackDone, ashby: ashbyDone };
  const firstOpen = order.find((k) => !doneMap[k]) ?? null;
  const current: StepKey | null = redo ?? firstOpen;
  const stateOf = (k: StepKey): StepState => {
    if (k === current) return "current";
    if (doneMap[k]) return "done";
    return "upcoming";
  };
  const allDone = googleDone && slackDone && ashbyDone;
  const doneCount = order.filter((k) => doneMap[k]).length;

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
      setRedo(null);
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

      <main className="container max-w-2xl space-y-6 py-10">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Set up Add to Ashby</h1>
          <p className="text-sm text-muted-foreground">
            Three steps, about five minutes. When you're done, you can put any candidate you introduce in Slack straight
            into the client's Ashby, credited to you. Signed in as{" "}
            <span className="font-medium text-foreground">{user.email}</span>.
          </p>
          <div className="flex items-center gap-3 pt-1">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(doneCount / 3) * 100}%` }} />
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">{doneCount} of 3 done</span>
          </div>
        </div>

        <div className="space-y-3">
          {/* ── Step 1: Google ─────────────────────────────────────────── */}
          <StepCard
            n={1}
            title="Connect Google"
            state={stateOf("google")}
            doneSummary={<>Gmail and Calendar connected as {status.googleEmail ?? "your account"}.</>}
            onRedo={() => setRedo("google")}
          >
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Compass reads your Gmail to find a candidate's email address and adds interview reminders to your
                calendar. It only sends email when you press Send.
              </p>
              {status.googleConnected && !status.googleReady && (
                <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                  Google is connected but missing Gmail or Calendar permission. Connect again and tick every box Google
                  shows you.
                </p>
              )}
              <ol className="space-y-2 text-sm text-foreground">
                <Instruction n={1}>Press <b>Connect Google</b>.</Instruction>
                <Instruction n={2}>Choose your <b>@candidatelabs.com</b> account.</Instruction>
                <Instruction n={3}>
                  Leave every permission ticked and press <b>Continue</b>. You come straight back here.
                </Instruction>
              </ol>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => void connectGoogle()} disabled={busy === "google"} className="gap-2">
                  {busy === "google" && <Loader2 className="h-4 w-4 animate-spin" />}
                  {status.googleConnected ? "Connect Google again" : "Connect Google"}
                </Button>
                {redo === "google" && googleDone && (
                  <Button variant="ghost" onClick={() => setRedo(null)}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          </StepCard>

          {/* ── Step 2: Slack ──────────────────────────────────────────── */}
          <StepCard
            n={2}
            title="Connect Slack"
            state={stateOf("slack")}
            doneSummary={<>Connected to {status.slackTeamName ?? "Slack"} with the Ashby Uploader app.</>}
            waitingOn="Finish step 1 first."
            onRedo={() => setRedo("slack")}
          >
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                This lets the <b>Ashby Uploader</b> app read your own intro posts and the resume in the thread, and send
                you a private message when an upload is done. It never posts in client channels.
              </p>
              {status.slackConnected && !status.slackReady && (
                <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                  Slack is connected with older permissions. Connect again so Add to Ashby can read resumes and message
                  you.
                </p>
              )}
              <ol className="space-y-2 text-sm text-foreground">
                <Instruction n={1}>
                  Press <b>Connect Slack</b>. Slack opens in a new tab.
                </Instruction>
                <Instruction n={2}>
                  Check the workspace at the top right says <b>Candidate Labs</b>, then press <b>Allow</b>.
                </Instruction>
                <Instruction n={3}>Close that tab and come back here. This step ticks itself off.</Instruction>
              </ol>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => void connectSlack()} disabled={busy === "slack"} className="gap-2">
                  {busy === "slack" && <Loader2 className="h-4 w-4 animate-spin" />}
                  {status.slackConnected ? "Connect Slack again" : "Connect Slack"}
                </Button>
                {slackTabOpened && !slackDone && (
                  <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for Slack…
                  </span>
                )}
                {redo === "slack" && slackDone && (
                  <Button variant="ghost" onClick={() => setRedo(null)}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          </StepCard>

          {/* ── Step 3: Ashby ──────────────────────────────────────────── */}
          <StepCard
            n={3}
            title={ashbyExpired ? "Reconnect Ashby" : "Connect Ashby"}
            state={stateOf("ashby")}
            doneSummary={
              <>
                Connected as {ashby.session.email ?? user.email}
                {ashby.session.org_count ? ` · ${ashby.session.org_count} client orgs` : ""}
                {ashby.session.expires_estimate_at
                  ? ` · reconnect around ${new Date(ashby.session.expires_estimate_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                  : ""}
              </>
            }
            waitingOn="Finish the steps above first."
            onRedo={() => setRedo("ashby")}
          >
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Uploads run under <b>your own</b> Ashby login, so candidates are credited to you and only reach clients
                you have access to. You'll copy one value from Ashby and paste it below.
              </p>
              {ashbyExpired && (
                <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                  Your Ashby login expired, which happens about once a week. Uploads from Slack are paused until you
                  reconnect.
                </p>
              )}
              <AshbyUserConnect
                onConnected={() => {
                  setRedo(null);
                  void refreshAll();
                }}
              />
              {redo === "ashby" && ashbyDone && (
                <Button variant="ghost" onClick={() => setRedo(null)}>
                  Cancel
                </Button>
              )}
            </div>
          </StepCard>
        </div>

        {/* ── Done: how to use it ────────────────────────────────────── */}
        {allDone && !redo && (
          <section className="space-y-4 rounded-xl border border-primary/30 bg-primary/5 px-5 py-5">
            <div>
              <h2 className="text-base font-semibold text-foreground">You're set. Here's how to use it.</h2>
              <p className="mt-1 text-sm text-muted-foreground">Try it on your next intro post.</p>
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
                Check the form (client, role, email, resume, write-up) and press <b>Add to Ashby</b>. Nothing is sent to
                the client's Ashby until you do. You'll get a private message with the link.
              </Instruction>
            </ol>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={finish}>Go to the dashboard</Button>
              <a
                href="https://app.slack.com/client"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline"
              >
                Open Slack <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          </section>
        )}

        {!allDone && (
          <div className="flex justify-center">
            <Button variant="ghost" size="sm" onClick={finish} className="text-muted-foreground">
              Skip for now and go to the dashboard
            </Button>
          </div>
        )}
      </main>
    </div>
  );
};

export default Onboarding;
