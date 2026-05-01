import { useState, useEffect } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, Users } from "lucide-react";

const PENDING_CALENDAR_KEY = "pendingCalendarConnect";
const PENDING_ONBOARDING_KEY = "pendingOnboarding";

const Auth = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [showEmail, setShowEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "Sign in — Candidate Pipeline";
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (user) return <Navigate to="/" replace />;

  const handleEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      // Email-path users still get steered through onboarding.
      sessionStorage.setItem(PENDING_ONBOARDING_KEY, "1");
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/` },
        });
        if (error) throw error;
        toast.success("Check your email to confirm your account.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate("/", { replace: true });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

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
        toast.error("Google sign-in failed");
        setBusy(false);
        return;
      }
      if (result.redirected) return;
      navigate("/", { replace: true });
    } catch {
      toast.error("Google sign-in failed");
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
            Sign in with Google to get started in under a minute.
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
            One sign-in covers your account, Calendar, and Gmail.
          </p>
        </div>

        {!showEmail ? (
          <div className="text-center">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
              onClick={() => setShowEmail(true)}
            >
              Use email instead
            </button>
          </div>
        ) : (
          <>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">Or</span>
              </div>
            </div>

            <form onSubmit={handleEmail} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <Button type="submit" variant="outline" className="w-full" disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {mode === "signup" ? "Create account" : "Sign in"}
              </Button>
            </form>

            <p className="text-sm text-center text-muted-foreground">
              {mode === "signin" ? "Don't have an account?" : "Already have an account?"}{" "}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
              >
                {mode === "signin" ? "Sign up" : "Sign in"}
              </button>
            </p>
          </>
        )}
      </Card>
    </div>
  );
};

export default Auth;
