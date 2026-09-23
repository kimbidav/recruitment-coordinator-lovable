import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Mail, Search, Send, Loader2, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Candidate } from "@/data/candidates";
import { useAuth } from "@/contexts/AuthContext";

interface EmailComposerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidateName: string;
  /** All candidate rows for this person across opportunities/companies. */
  opportunities: Candidate[];
  initialSubject?: string;
  initialBody?: string;
  initialTo?: string;
  /** When set, sending goes through this (e.g. agent-act) instead of gmail-helper. */
  onSend?: (args: { to: string; subject: string; body: string }) => Promise<void>;
}

export interface EmailLookupResult {
  email: string | null;
  confidence: "high" | "medium" | "low" | "none";
  evidence?: Array<{ kind: string; subject: string; date: string; detail: string }>;
  candidates?: Array<{ email: string; confidence: string; display_names?: string[] }>;
}

const EVIDENCE_LABEL: Record<string, string> = {
  you_emailed: "You emailed them",
  they_emailed: "They emailed you",
  calendly_invitee: "Calendly invitee",
  mention: "Copied on a thread",
  scheduling_notice: "Scheduling notice",
};

function formatEvidenceDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
}

/**
 * Why the resolver picked (or refused to pick) an address. Mirrors the
 * desktop overlay: a confidence pill plus up to three evidence lines at
 * high/medium; at low, amber copy and "Use" chips — never an auto-fill.
 */
function LookupEvidence({ lookup, onUse }: { lookup: EmailLookupResult; onUse: (email: string) => void }) {
  const confident = !!lookup.email && (lookup.confidence === "high" || lookup.confidence === "medium");
  if (confident) {
    const pill =
      lookup.confidence === "high"
        ? "bg-status-success/10 text-status-success border-status-success/30"
        : "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30";
    return (
      <div className="space-y-1 pt-1 text-xs">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center rounded border px-1.5 py-0.5 font-medium ${pill}`}>
            {lookup.confidence === "high" ? "Found" : "Likely"} · {lookup.confidence} confidence
          </span>
          <span className="text-muted-foreground">{lookup.email}</span>
        </div>
        <ul className="text-muted-foreground">
          {(lookup.evidence ?? []).slice(0, 3).map((e, i) => (
            <li key={i}>
              {EVIDENCE_LABEL[e.kind] ?? e.detail}
              {e.subject ? ` · “${e.subject}”` : ""}
              {e.date ? ` · ${formatEvidenceDate(e.date)}` : ""}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const chips = (lookup.candidates ?? []).map((c) => c.email).filter(Boolean).slice(0, 3);
  if (chips.length === 0) return null;
  return (
    <div className="space-y-1 pt-1 text-xs">
      <p className="text-amber-700 dark:text-amber-400">
        Couldn't confirm an address — pick one only if you recognize it.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((email) => (
          <button
            key={email}
            type="button"
            onClick={() => onUse(email)}
            className="rounded border border-border bg-card px-2 py-0.5 hover:bg-muted transition-colors"
          >
            Use {email}
          </button>
        ))}
      </div>
    </div>
  );
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] || full;
}

function isOpportunityClosed(c: Candidate): boolean {
  const decision = (c.decision_status || "").toLowerCase();
  const stage = (c.pipeline_stage || "").toLowerCase();
  return (
    ["rejected", "withdrawn", "archived", "hired", "closed"].some((k) => decision.includes(k)) ||
    ["disqualified", "not in process", "rejected", "withdrawn", "hired", "archived"].some((k) =>
      stage.includes(k),
    )
  );
}

// Status mapping (mirrors the desktop app's compose_candidate_message):
//   closed              → "no longer moving forward"
//   active with a stage → the stage name (e.g. "Onsite Interview")
//   active, no stage    → "in process"
function opportunityDetail(o: Candidate): string {
  if (isOpportunityClosed(o)) return "no longer moving forward";
  const stage = (o.pipeline_stage || "").trim();
  return stage || "in process";
}

function buildDraft(
  name: string,
  opps: Candidate[],
  senderFirstName?: string,
): { subject: string; body: string } {
  const subject = "Checking in on your interviews";
  const bullets =
    opps.length > 0
      ? opps.map((o) => `• ${o.company_name} — ${opportunityDetail(o)}`)
      : ["• (no opportunities found)"];
  const lines = [
    `Hi ${firstName(name)},`,
    "",
    "I just wanted to check in with you to see how your interviews are coming along. Here are the latest updates I have on each opportunity below:",
    "",
    ...bullets,
    "",
    "Let me know if you have any questions along the way!",
    "",
    senderFirstName ? `Best,\n${senderFirstName}` : "Best,",
  ];
  return { subject, body: lines.join("\n") };
}

export function EmailComposer({
  open,
  onOpenChange,
  candidateName,
  opportunities,
  initialSubject,
  initialBody,
  initialTo,
  onSend,
}: EmailComposerProps) {
  const { user } = useAuth();
  // Sign-off name: Google OAuth full name when available, else the email
  // local-part (capitalized) as a best effort.
  const senderFirstName = useMemo(() => {
    const meta = user?.user_metadata as { full_name?: string; name?: string } | undefined;
    const full = (meta?.full_name || meta?.name || "").trim();
    if (full) return full.split(/\s+/)[0];
    const local = (user?.email ?? "").split("@")[0];
    return local ? local.charAt(0).toUpperCase() + local.slice(1) : undefined;
  }, [user?.user_metadata, user?.email]);
  const draft = useMemo(
    () => buildDraft(candidateName, opportunities, senderFirstName),
    [candidateName, opportunities, senderFirstName],
  );
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(initialSubject ?? draft.subject);
  const [body, setBody] = useState(initialBody ?? draft.body);
  const [sending, setSending] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [needsReconnect, setNeedsReconnect] = useState<null | "google_not_connected" | "gmail_scope_missing">(null);
  // Resolver output. `email` is set only at high/medium confidence; at low
  // the candidates are shown as chips the user must pick deliberately.
  const [lookup, setLookup] = useState<EmailLookupResult | null>(null);

  // Reset content when reopened for a different candidate.
  useEffect(() => {
    if (open) {
      setTo(initialTo ?? "");
      setSubject(initialSubject ?? draft.subject);
      setBody(initialBody ?? draft.body);
      setLookup(null);
      setNeedsReconnect(null);
    }
  }, [open, draft.subject, draft.body, initialSubject, initialBody, initialTo]);

  const handleReconnectGoogle = async () => {
    setReconnecting(true);
    try {
      const redirectUri = `${window.location.origin}/google-calendar/callback`;
      const { data, error } = await supabase.functions.invoke("google-calendar-connect", {
        body: { redirect_uri: redirectUri },
      });
      if (error || !data?.url) {
        toast.error(`Failed to start Google reconnect: ${error?.message || data?.error || "no url"}`);
        return;
      }
      window.location.href = data.url;
    } finally {
      setReconnecting(false);
    }
  };

  const parseFnError = async (
    error: unknown,
    data: { error?: string; code?: string } | null,
  ): Promise<{ message: string; code?: string }> => {
    // Try response body first (works for 2xx responses)
    if (data?.error) return { message: data.error, code: data.code };
    // Then try the error.context.body for non-2xx responses
    const ctx = (error as { context?: Response })?.context;
    if (ctx && typeof ctx.text === "function") {
      try {
        const txt = await ctx.text();
        const parsed = JSON.parse(txt) as { error?: string; code?: string };
        if (parsed?.error) return { message: parsed.error, code: parsed.code };
      } catch {
        /* ignore */
      }
    }
    return { message: error instanceof Error ? error.message : "Request failed" };
  };

  const friendlyMessage = (msg: string, code?: string): string => {
    if (code === "google_not_connected") return "Connect Google Calendar first to enable Gmail.";
    if (code === "gmail_scope_missing")
      return "Reconnect Google to grant Gmail access (Disconnect → Connect Google Calendar).";
    return msg;
  };

  const handleLookup = async () => {
    setLookingUp(true);
    try {
      const { data, error } = await supabase.functions.invoke("gmail-helper", {
        body: { action: "lookup", name: candidateName },
      });
      if (error || data?.error) {
        const { message, code } = await parseFnError(error, data ?? null);
        if (code === "google_not_connected" || code === "gmail_scope_missing") {
          setNeedsReconnect(code);
        }
        toast.error(friendlyMessage(message, code));
        return;
      }
      setNeedsReconnect(null);
      const result = data as EmailLookupResult;
      setLookup(result);
      if (result.email && (result.confidence === "high" || result.confidence === "medium")) {
        // Confident: fill the field (the pill + evidence below say why).
        if (!to || to === lookup?.email) setTo(result.email);
      } else if ((result.candidates ?? []).length > 0) {
        toast.info(`Couldn't confirm ${candidateName}'s email — pick one below only if you recognize it.`);
      } else {
        toast.info(`No email found for ${candidateName} in your Gmail.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Lookup failed";
      toast.error(msg);
    } finally {
      setLookingUp(false);
    }
  };


  const handleSend = async () => {
    if (!to.trim()) {
      toast.error("Recipient email required");
      return;
    }
    setSending(true);
    try {
      if (onSend) {
        await onSend({ to: to.trim(), subject, body });
        toast.success("Email sent");
        onOpenChange(false);
        return;
      }
      const { data, error } = await supabase.functions.invoke("gmail-helper", {
        body: { action: "send", to: to.trim(), subject, body },
      });
      if (error || data?.error) {
        const { message, code } = await parseFnError(error, data ?? null);
        if (code === "google_not_connected" || code === "gmail_scope_missing") {
          setNeedsReconnect(code);
        }
        toast.error(friendlyMessage(message, code));
        return;
      }
      setNeedsReconnect(null);
      toast.success(`Email sent from ${data.from ?? "your Gmail"}`);
      onOpenChange(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Send failed";
      toast.error(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" />
            Email {candidateName}
          </DialogTitle>
          <DialogDescription>
            Sent from your connected Gmail account.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {needsReconnect && (
            <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 space-y-2 min-w-0">
                <p className="text-sm text-foreground">
                  {needsReconnect === "google_not_connected"
                    ? "Google isn't connected yet. Reconnect to enable Gmail lookup and sending."
                    : "Gmail access is missing from your Google connection. Reconnect to grant Gmail permissions."}
                </p>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleReconnectGoogle()}
                  disabled={reconnecting}
                  className="gap-2"
                >
                  {reconnecting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Mail className="h-3.5 w-3.5" />
                  )}
                  Reconnect Google
                </Button>
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="email-to">To</Label>
            <div className="flex gap-2">
              <Input
                id="email-to"
                type="email"
                placeholder="candidate@email.com"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleLookup()}
                disabled={lookingUp}
                className="shrink-0"
              >
                {lookingUp ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Search className="h-3.5 w-3.5" />
                )}
                Look up from Gmail
              </Button>
            </div>
            {lookup && <LookupEvidence lookup={lookup} onUse={setTo} />}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email-subject">Subject</Label>
            <Input
              id="email-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          {opportunities.length > 0 && (
            <div className="space-y-1.5">
              <Label>Opportunities</Label>
              <div className="border border-border rounded-md p-3 bg-muted/30 space-y-1">
                {opportunities.map((o) => {
                  const closed = isOpportunityClosed(o);
                  return (
                    <div key={o.candidate_id} className="flex items-center gap-2 text-sm">
                      <span
                        className={
                          closed ? "text-muted-foreground line-through" : "text-foreground"
                        }
                      >
                        {o.company_name}
                      </span>
                      <span
                        className={
                          "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded " +
                          (closed
                            ? "bg-muted text-muted-foreground"
                            : "bg-status-success/10 text-status-success")
                        }
                      >
                        {closed ? "Closed" : (o.pipeline_stage || "").trim() || "In process"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="email-body">Message</Label>
            <Textarea
              id="email-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="font-mono text-sm"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={() => void handleSend()} disabled={sending || !to.trim()}>
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Send Email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
