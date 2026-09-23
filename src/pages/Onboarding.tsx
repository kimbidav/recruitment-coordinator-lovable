import { useEffect } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useOnboardingStatus } from "@/hooks/useOnboardingStatus";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Check, Loader2, LogOut, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { SlackConnectButton } from "@/components/SlackConnectButton";
import { AshbyFetchButton } from "@/components/AshbyFetchButton";
import { AshbyUserConnect } from "@/components/AshbyUserConnect";
import { GoogleCalendarSync } from "@/components/GoogleCalendarSync";
import { PostSignInCalendarPrompt } from "@/components/PostSignInCalendarPrompt";
import { RecruiterAliasStep } from "@/components/RecruiterAliasStep";
import { usePipelineSession } from "@/hooks/usePipelineSession";
import { useRecruiterAliases } from "@/hooks/useRecruiterAliases";

const ONBOARDING_DISMISSED_KEY = "onboardingDismissed";
const PENDING_ONBOARDING_KEY = "pendingOnboarding";

interface StepRowProps {
  index: number;
  title: string;
  caption: string;
  done: boolean;
  doneLabel?: string;
  optional?: boolean;
  action: React.ReactNode;
}

const StepRow = ({ index, title, caption, done, doneLabel, optional, action }: StepRowProps) => (
  <div className="flex items-start gap-4 p-5 rounded-lg border border-border bg-card">
    <div
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium",
        done
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground border border-border",
      )}
    >
      {done ? <Check className="h-4 w-4" /> : index}
    </div>
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {optional && (
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            Optional
          </span>
        )}
        <span
          className={cn(
            "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ml-auto",
            done
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {done ? doneLabel ?? "Connected" : "Pending"}
        </span>
      </div>
      <p className="text-sm text-muted-foreground mt-1">{caption}</p>
      <div className="mt-3">{action}</div>
    </div>
  </div>
);

const Onboarding = () => {
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const status = useOnboardingStatus();
  const { aliases, refreshAliases } = useRecruiterAliases();

  useEffect(() => {
    document.title = "Welcome — Candidate Compass";
    // /onboarding?step=ashby (from the Slack modal's Reconnect button and the
    // expiry banner) lands on the Ashby step.
    if (new URLSearchParams(window.location.search).get("step") === "ashby") {
      setTimeout(() => document.getElementById("step-ashby")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }, []);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!user) return <Navigate to="/auth" replace />;

  const handleContinue = () => {
    sessionStorage.removeItem(PENDING_ONBOARDING_KEY);
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
    navigate("/", { replace: true });
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Auto-trigger Google Calendar consent if it was queued during sign-in */}
      <PostSignInCalendarPrompt />

      <header className="border-b border-border bg-card">
        <div className="container py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-primary rounded">
              <Users className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="text-sm font-semibold">Candidate Pipeline</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={signOut}
            className="gap-2"
            title={user.email ?? "Sign out"}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </header>

      <main className="container max-w-2xl py-10 space-y-8">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Let's get you set up</h1>
          <p className="text-sm text-muted-foreground">
            Three quick connections, then Add to Ashby works from Slack.
            {user.email && <> Signed in as <span className="font-medium text-foreground">{user.email}</span>.</>}
          </p>
        </div>

        <Card className="p-6 space-y-3">
          <StepRow
            index={1}
            title="Google (Calendar + Gmail)"
            caption="Pull upcoming interviews into your calendar and send check-in emails right from the dashboard."
            done={status.googleConnected}
            doneLabel={status.googleEmail ? `Connected as ${status.googleEmail}` : "Connected"}
            action={
              status.googleConnected ? (
                <p className="text-xs text-muted-foreground">
                  You can revoke access anytime from your Google account.
                </p>
              ) : (
                <GoogleCalendarSync candidates={[]} />
              )
            }
          />

          <StepRow
            index={2}
            title="Connect Slack"
            caption="Read the candidate threads you posted in client channels so they show up here automatically."
            done={status.slackConnected}
            doneLabel={status.slackTeamName ? `${status.slackTeamName}` : "Connected"}
            action={<SlackConnectButton onSynced={() => void status.refresh()} />}
          />

          <div id="step-ashby">
            <StepRow
              index={3}
              title="Connect Ashby (yours)"
              caption="Add to Ashby in Slack uploads candidates under YOUR Ashby login, so they're credited to you and only reach clients you have access to. Ashby logins last about a week."
              done={status.ashbyConnected}
              doneLabel="Connected"
              action={<AshbyUserConnect onChanged={() => void status.refresh()} />}
            />
          </div>

          <StepRow
            index={4}
            title="Team pipeline sync"
            caption="Reading the whole team's Ashby pipeline uses one shared connection. If it's already healthy you can skip this; if it shows Reconnect, any teammate's login fixes it for everyone."
            done={status.teamAshbyConnected}
            optional
            action={
              <AshbyFetchButton
                onSyncComplete={async () => {
                  void status.refresh();
                }}
              />
            }
          />

          <StepRow
            index={5}
            title="Your name in Ashby"
            caption="Pick how you appear as the submitter in Ashby so the dashboard can default to YOUR candidates."
            done={aliases.length > 0}
            doneLabel={aliases.length > 0 ? aliases[0] : undefined}
            optional
            action={<RecruiterAliasStep onSaved={() => void refreshAliases()} />}
          />
        </Card>

        <div className="flex flex-col items-center gap-3">
          <Button onClick={handleContinue} className="w-full sm:w-auto px-8">
            Continue to dashboard
          </Button>
          <p className="text-xs text-muted-foreground">
            You can finish any of these later from the dashboard header.
          </p>
        </div>
      </main>
    </div>
  );
};

export default Onboarding;
