import { useState, useEffect } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { lovable } from "@/integrations/lovable";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, Users } from "lucide-react";

const PENDING_CALENDAR_KEY = "pendingCalendarConnect";
const PENDING_ONBOARDING_KEY = "pendingOnboarding";

// Google only. Every recruiter has a @candidatelabs.com Google account, and
// the database refuses any other domain (enforce_candidatelabs_domain), so
// an email/password path would only ever produce a confusing failure.
const Auth = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "Sign in — Candidate Compass";
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (user) return <Navigate to="/" replace />;

  const handleGoogle = async () => {
    setBusy(true);
    try {
      // Always trigger the Calendar/Gmail consent right after sign-in so
      // the user only goes through one Google round-trip.
      sessionStorage.setItem(PENDING_CALENDAR_KEY, "1");
      sessionStorage.setItem(PENDING_ONBOARDING_KEY, "1");
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
      });
      if (result.error) {
        toast.error("Google sign-in failed. Use your Candidate Labs Google account.");
        setBusy(false);
        return;
      }
      if (result.redirected) return;
      navigate("/", { replace: true });
    } catch {
      toast.error("Google sign-in failed. Use your Candidate Labs Google account.");
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md p-8 space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="p-2 bg-primary rounded-lg">
            <Users className="h-5 w-5 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-semibold">Welcome</h1>
          <p className="text-sm text-muted-foreground">
            Sign in with your Candidate Labs Google account.
          </p>
        </div>

        <div className="space-y-3">
          <Button
            className="w-full h-11 text-sm font-medium"
            onClick={handleGoogle}
            disabled={busy}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Continue with Google
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            One sign-in covers your account, Calendar, and Gmail. Only
            @candidatelabs.com accounts can sign in.
          </p>
        </div>
      </Card>
    </div>
  );
};

export default Auth;
