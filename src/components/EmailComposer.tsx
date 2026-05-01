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
import { Mail, Search, Send, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Candidate } from "@/data/candidates";

interface EmailComposerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidateName: string;
  /** All candidate rows for this person across opportunities/companies. */
  opportunities: Candidate[];
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

function buildDraft(name: string, opps: Candidate[]): { subject: string; body: string } {
  const subject = "Checking in on your interviews";
  const lines = [
    `Hi ${firstName(name)},`,
    "",
    "I just wanted to check in with you to see how your interviews are coming along. Here are the latest updates I have on each opportunity below:",
    "",
    ...opps.map((o) => {
      const closed = isOpportunityClosed(o);
      return `• ${o.company_name} — ${closed ? "no longer moving forward" : "in process"}`;
    }),
    "",
    "Let me know if you have any questions or updates along the way.",
  ];
  return { subject, body: lines.join("\n") };
}

export function EmailComposer({
  open,
  onOpenChange,
  candidateName,
  opportunities,
}: EmailComposerProps) {
  const draft = useMemo(() => buildDraft(candidateName, opportunities), [candidateName, opportunities]);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [sending, setSending] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [suggestions, setSuggestions] = useState<{ email: string; count: number }[]>([]);

  // Reset content when reopened for a different candidate.
  useEffect(() => {
    if (open) {
      setTo("");
      setSubject(draft.subject);
      setBody(draft.body);
      setSuggestions([]);
    }
  }, [open, draft.subject, draft.body]);

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
        toast.error(friendlyMessage(message, code));
        return;
      }
      const results = (data.results ?? []) as { email: string; count: number }[];
      setSuggestions(results);
      if (results.length === 0) {
        toast.info(`No email found for ${candidateName} in your Gmail.`);
      } else if (!to) {
        setTo(results[0].email);
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
      const { data, error } = await supabase.functions.invoke("gmail-helper", {
        body: { action: "send", to: to.trim(), subject, body },
      });
      if (error) throw error;
      if (data?.error) {
        if (data.code === "gmail_scope_missing") {
          throw new Error("Reconnect Google to grant 'Send mail' permission.");
        }
        if (data.code === "google_not_connected") {
          throw new Error("Connect Google Calendar to enable email sending.");
        }
        throw new Error(data.error);
      }
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
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {suggestions.map((s) => (
                  <button
                    key={s.email}
                    type="button"
                    onClick={() => setTo(s.email)}
                    className="text-xs px-2 py-0.5 rounded border border-border bg-card hover:bg-muted transition-colors"
                    title={`Found in ${s.count} message${s.count === 1 ? "" : "s"}`}
                  >
                    {s.email}
                  </button>
                ))}
              </div>
            )}
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
                        {closed ? "Closed" : "In process"}
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
