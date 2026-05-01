import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Calendar, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Candidate } from "@/data/candidates";
import { supabase } from "@/integrations/supabase/client";

interface GoogleCalendarSyncProps {
  /** Currently filtered candidate list — only these will be pushed to Google Calendar. */
  candidates: Candidate[];
}

interface PreparedEvent {
  id: string;
  interview_title: string;
  start_time: string;
  end_time: string;
  candidate_name: string;
  company_name: string;
}

export const GoogleCalendarSync = ({ candidates }: GoogleCalendarSyncProps) => {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("google_calendar_tokens")
        .select("google_email")
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setConnected(false);
        return;
      }
      setConnected(!!data);
      setEmail(data?.google_email ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleConnect = async () => {
    setIsLoading(true);
    try {
      const redirectUri = `${window.location.origin}/google-calendar/callback`;
      const { data, error } = await supabase.functions.invoke("google-calendar-connect", {
        body: { redirect_uri: redirectUri },
      });
      if (error || !data?.url) {
        toast.error(`Failed to start Google auth: ${error?.message || data?.error || "no url"}`);
        return;
      }
      window.location.href = data.url;
    } finally {
      setIsLoading(false);
    }
  };

  // Compute upcoming events from the *currently filtered* candidate list.
  const upcomingEvents = useMemo<PreparedEvent[]>(() => {
    const now = new Date();
    const currentYear = now.getFullYear();

    const extractDateFromInterviews = (
      interviews: string,
      fallbackDate?: string,
    ): Date | null => {
      const dateMatch = interviews.match(/\((\d{2})\/(\d{2})\)/);
      if (dateMatch) {
        return new Date(
          currentYear,
          parseInt(dateMatch[1], 10) - 1,
          parseInt(dateMatch[2], 10),
          17,
          0,
          0,
        );
      }
      if (fallbackDate) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(fallbackDate)) return new Date(fallbackDate + "T17:00:00");
        return new Date(fallbackDate);
      }
      return null;
    };

    return candidates
      .filter((c) => c.current_stage_interviews)
      .map((c): PreparedEvent | null => {
        const stageDate = extractDateFromInterviews(
          c.current_stage_interviews!,
          c.current_stage_date,
        );
        if (!stageDate || isNaN(stageDate.getTime())) return null;
        return {
          id: c.candidate_id,
          interview_title: `${c.candidate_name} x ${c.company_name} (${c.pipeline_stage})`,
          start_time: stageDate.toISOString(),
          end_time: new Date(stageDate.getTime() + 30 * 60 * 1000).toISOString(),
          candidate_name: c.candidate_name,
          company_name: c.company_name,
        };
      })
      .filter((e): e is PreparedEvent => e !== null && new Date(e.start_time) >= now)
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  }, [candidates]);

  const handleSyncClick = () => {
    if (upcomingEvents.length === 0) {
      toast.info("No upcoming interviews in the filtered list");
      return;
    }
    setConfirmOpen(true);
  };

  const handleConfirmSync = async () => {
    setIsLoading(true);
    try {
      // Strip the display-only fields before sending.
      const payload = upcomingEvents.map(({ id, interview_title, start_time, end_time }) => ({
        id,
        interview_title,
        start_time,
        end_time,
      }));
      const { data, error } = await supabase.functions.invoke("google-calendar-sync", {
        body: { events: payload },
      });
      if (error || data?.error) {
        toast.error(`Sync failed: ${error?.message || data?.error}`);
        if ((data?.error || "").toLowerCase().includes("not connected")) setConnected(false);
        return;
      }
      toast.success(data?.message || `Synced ${payload.length} events`);
      setConfirmOpen(false);
    } finally {
      setIsLoading(false);
    }
  };

  if (connected === null) {
    return (
      <Button variant="outline" size="sm" disabled className="gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
      </Button>
    );
  }

  if (!connected) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={handleConnect}
        disabled={isLoading}
        className="gap-2"
      >
        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calendar className="h-4 w-4" />}
        Connect Google Calendar
      </Button>
    );
  }

  const previewLimit = 8;
  const previewed = upcomingEvents.slice(0, previewLimit);
  const remaining = upcomingEvents.length - previewed.length;
  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={handleSyncClick}
        disabled={isLoading || upcomingEvents.length === 0}
        className="gap-2"
        title={
          email
            ? `Connected as ${email} — pushes the ${upcomingEvents.length} upcoming interviews in the filtered list`
            : "Connected"
        }
      >
        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calendar className="h-4 w-4" />}
        Sync filtered to Calendar
        {upcomingEvents.length > 0 && (
          <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {upcomingEvents.length}
          </span>
        )}
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Push {upcomingEvents.length} interview{upcomingEvents.length === 1 ? "" : "s"} to Google
              Calendar?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  These are the upcoming interviews in your <strong>currently filtered</strong> list
                  {email ? (
                    <>
                      . They'll be added to <strong>{email}</strong>.
                    </>
                  ) : (
                    "."
                  )}{" "}
                  Adjust your filters first if you only want to push a subset (e.g. by Submitter).
                </p>
                <ul className="max-h-64 overflow-y-auto rounded-md border border-border bg-muted/40 p-2 text-xs space-y-1">
                  {previewed.map((ev) => (
                    <li key={ev.id} className="flex justify-between gap-2">
                      <span className="truncate">
                        <span className="font-medium text-foreground">{ev.candidate_name}</span>{" "}
                        <span className="text-muted-foreground">× {ev.company_name}</span>
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {formatDate(ev.start_time)}
                      </span>
                    </li>
                  ))}
                  {remaining > 0 && (
                    <li className="pt-1 text-center text-muted-foreground">
                      + {remaining} more
                    </li>
                  )}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmSync} disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Syncing…
                </>
              ) : (
                `Push ${upcomingEvents.length} to Calendar`
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
