import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

const GoogleCalendarCallback = () => {
  const navigate = useNavigate();
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");

    const finish = (msg: string, ok: boolean) => {
      ok ? toast.success(msg) : toast.error(msg);
      navigate("/", { replace: true });
    };

    if (error) return finish(`Google auth error: ${error}`, false);
    if (!code) return finish("Missing authorization code", false);

    const redirectUri = `${window.location.origin}/google-calendar/callback`;
    (async () => {
      const { data, error: invokeErr } = await supabase.functions.invoke(
        "google-calendar-callback",
        { body: { code, redirect_uri: redirectUri, state } },
      );
      if (invokeErr || (data && data.error)) {
        finish(`Connect failed: ${invokeErr?.message || data?.error}`, false);
        return;
      }
      finish(`Google Calendar connected${data?.email ? ` (${data.email})` : ""}`, true);
    })();
  }, [navigate]);

  return (
    <div className="min-h-screen grid place-items-center text-muted-foreground">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Finishing Google Calendar connection…
      </div>
    </div>
  );
};

export default GoogleCalendarCallback;
