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
  /** YYYY-MM-DD, the interview's calendar date. */
  interview_date: string;
  candidate_name: string;
  company_name: string;
  credited_to: string;
  credited_to_email: string | null;
}

const COMMON_TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
];

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";
  } catch {
    return "America/Los_Angeles";
  }
}

function localIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const GoogleCalendarSync = ({ candidates }: GoogleCalendarSyncProps) => {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [timeZone, setTimeZone] = useState<string>(browserTimeZone());
  const [preview, setPreview] = useState<{ message: string; results: Array<{ title: string; date: string; outcome: string; detail?: string }> } | null>(null);

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
      // The saved reminder timezone, if the recruiter chose one before.
      const { data: settings } = await supabase.from("agent_settings").select("timezone").maybeSingle();
      if (!cancelled && settings?.timezone) setTimeZone(settings.timezone);
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
        const first = c.candidate_name.trim().split(/\s+/)[0] || c.candidate_name;
        return {
          id: c.candidate_id,
          // Reminder title is "{First} x {Client}" — the server derives the
          // dedup identity from candidate/company/date, not from this string.
          interview_title: `${first} x ${c.company_name}`,
          start_time: stageDate.toISOString(),
          end_time: new Date(stageDate.getTime() + 30 * 60 * 1000).toISOString(),
          interview_date: localIsoDate(stageDate),
          candidate_name: c.candidate_name,
          company_name: c.company_name,
          credited_to: c.credited_to ?? "",
          credited_to_email: c.credited_to_email ?? null,
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

  const buildPayload = () =>
    // credited_to / credited_to_email ride along so the server can enforce the
    // only-my-candidates guard — the org shares one pipeline, and a stray
    // "Everyone" filter must not schedule teammates' interviews.
    upcomingEvents.map(({ id, interview_title, start_time, end_time, interview_date, candidate_name, company_name, credited_to, credited_to_email }) => ({
      id, interview_title, start_time, end_time, interview_date, candidate_name, company_name, credited_to, credited_to_email,
    }));

  const runSync = async (dryRun: boolean) => {
    setIsLoading(true);
    try {
      const payload = buildPayload();
      const { data, error } = await supabase.functions.invoke("google-calendar-sync", {
        body: { events: payload, timezone: timeZone, dry_run: dryRun },
      });
      if (error || data?.error) {
        toast.error(`${dryRun ? "Preview" : "Sync"} failed: ${error?.message || data?.error}`);
        if ((data?.error || "").toLowerCase().includes("not connected")) setConnected(false);
        return;
      }
      if (dryRun) {
        setPreview({ message: data?.message ?? "", results: data?.results ?? [] });
        return;
      }
      const errs: string[] = data?.errors ?? [];
      if (errs.length) toast.warning(`${data?.message}. ${errs.length} error${errs.length === 1 ? "" : "s"}: ${errs[0]}`);
      else toast.success(data?.message || `Synced ${payload.length} events`);
      setPreview(null);
      setConfirmOpen(false);
    } finally {
      setIsLoading(false);
    }
  };
  const handleConfirmSync = () => void runSync(false);

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
    new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

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
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Reminder at 5:00 PM in
                  <select
                    className="rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground"
                    value={timeZone}
                    onChange={(e) => setTimeZone(e.target.value)}
                  >
                    {Array.from(new Set([timeZone, browserTimeZone(), ...COMMON_TIMEZONES])).map((tz) => (
                      <option key={tz} value={tz}>
                        {tz.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                </label>
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
                {preview && (
                  <div className="rounded-md border border-border bg-muted/40 p-2 text-xs">
                    <p className="font-medium text-foreground">{preview.message}</p>
                    <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-muted-foreground">
                      {preview.results.map((r, i) => (
                        <li key={i}>
                          {r.title} · {r.date} — {r.outcome.replace(/_/g, " ")}
                          {r.detail ? ` (${r.detail})` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
            <Button type="button" variant="outline" onClick={() => void runSync(true)} disabled={isLoading}>
              Preview (dry run)
            </Button>
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
