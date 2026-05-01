import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export default function SlackCallback() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [status, setStatus] = useState<"processing" | "error">("processing");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");

    if (error) {
      setStatus("error");
      setErrorMsg(`Slack reported: ${error}`);
      return;
    }
    if (!code || !state) {
      setStatus("error");
      setErrorMsg("Missing code or state in callback URL.");
      return;
    }

    const redirectUri = `${window.location.origin}/slack/callback`;
    void (async () => {
      const { data, error: invokeErr } = await supabase.functions.invoke("slack-callback", {
        body: { code, state, redirect_uri: redirectUri },
      });
      if (invokeErr || data?.error) {
        setStatus("error");
        setErrorMsg(invokeErr?.message ?? data?.error ?? "Unknown error");
        return;
      }
      toast.success(`Slack connected${data?.team_name ? ` (${data.team_name})` : ""}`);
      // If opened in a popup/new tab from the dashboard, notify the opener and close.
      if (window.opener && !window.opener.closed) {
        try {
          window.opener.postMessage({ type: "slack-connected" }, window.location.origin);
        } catch {
          // ignore cross-origin issues
        }
        window.close();
        return;
      }
      navigate("/?slack=connected", { replace: true });
    })();
  }, [params, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      {status === "processing" ? (
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Connecting your Slack account…</span>
        </div>
      ) : (
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-lg font-semibold">Couldn't connect Slack</h1>
          <p className="text-sm text-muted-foreground">{errorMsg}</p>
          <button
            className="text-sm underline text-primary"
            onClick={() => navigate("/", { replace: true })}
          >
            Back to dashboard
          </button>
        </div>
      )}
    </div>
  );
}
