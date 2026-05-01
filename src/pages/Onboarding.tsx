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
import { GoogleCalendarSync } from "@/components/GoogleCalendarSync";
import { PostSignInCalendarPrompt } from "@/components/PostSignInCalendarPrompt";

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

  useEffect(() => {
    document.title = "Welcome — Candidate Pipeline";
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
            Three quick connections so your pipeline stays in sync.
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

          <StepRow
            index={3}
            title="Connect Ashby"
            caption="Pull the latest pipeline stages, feedback, and interview history from Ashby."
            done={status.ashbyConnected}
            action={
              <AshbyFetchButton
                onUpload={() => {
                  void status.refresh();
                }}
              />
            }
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
