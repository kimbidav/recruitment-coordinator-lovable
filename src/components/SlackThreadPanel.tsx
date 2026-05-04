import { useEffect, useMemo, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Send, RefreshCw, MessagesSquare } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { format } from "date-fns";

interface SlackUser {
  id: string;
  name: string;
  real_name: string;
  image: string | null;
}

interface SlackMessage {
  ts: string;
  user_id: string | null;
  user_name: string;
  user_image: string | null;
  text: string;
  reactions: { name: string; count: number }[];
}

interface SlackThreadPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string | null;
  messageTs: string | null;
  candidateName: string;
  companyName: string;
  initialReply?: string;
}

interface SlackThreadInlineProps {
  channelId: string | null;
  messageTs: string | null;
  initialReply?: string;
  /** Cap height of the messages list. Default 320px */
  maxMessagesHeight?: number;
}

const POLL_MS = 10_000;

export function SlackThreadPanel({
  open,
  onOpenChange,
  channelId,
  messageTs,
  candidateName,
  companyName,
  initialReply,
}: SlackThreadPanelProps) {
  const [messages, setMessages] = useState<SlackMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // @mention autocomplete state
  const [users, setUsers] = useState<SlackUser[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  const filteredUsers = useMemo(() => {
    if (!mentionOpen) return [];
    const q = mentionQuery.toLowerCase();
    const matches = users.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.real_name.toLowerCase().includes(q),
    );
    return matches.slice(0, 8);
  }, [mentionOpen, mentionQuery, users]);

  // Load workspace users (once per open) for @mentions
  useEffect(() => {
    if (!open || users.length > 0) return;
    (async () => {
      try {
        const { data, error: invErr } = await supabase.functions.invoke("slack-thread", {
          body: { action: "users" },
        });
        if (invErr) throw invErr;
        if (data?.error) throw new Error(data.error);
        setUsers(data.users ?? []);
      } catch {
        // Non-fatal — autocomplete just won't appear.
      }
    })();
  }, [open, users.length]);

  const load = async () => {
    if (!channelId || !messageTs) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: invErr } = await supabase.functions.invoke("slack-thread", {
        body: { action: "fetch", channel_id: channelId, message_ts: messageTs },
      });
      if (invErr) throw invErr;
      if (data?.error) throw new Error(data.error);
      setMessages(data.messages ?? []);
      // Scroll to bottom on first load
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load thread";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  // Initial load + polling while open
  useEffect(() => {
    if (!open || !channelId || !messageTs) return;
    if (initialReply !== undefined) setReply(initialReply);
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, channelId, messageTs]);

  // Convert "@displayname" tokens in the draft into Slack mention syntax "<@U123>".
  // Longest matching name wins to handle names that overlap (e.g. "shel" vs "shelby").
  const encodeMentions = (raw: string): string => {
    if (users.length === 0) return raw;
    const sorted = [...users].sort((a, b) => b.name.length - a.name.length);
    let out = raw;
    for (const u of sorted) {
      const escaped = u.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`@${escaped}\\b`, "gi");
      out = out.replace(re, `<@${u.id}>`);
    }
    return out;
  };

  const handleSend = async () => {
    const text = reply.trim();
    if (!text || !channelId || !messageTs) return;
    setSending(true);
    try {
      const { data, error: invErr } = await supabase.functions.invoke("slack-thread", {
        body: {
          action: "reply",
          channel_id: channelId,
          message_ts: messageTs,
          text: encodeMentions(text),
        },
      });
      if (invErr) throw invErr;
      if (data?.error) throw new Error(data.error);
      setReply("");
      setMentionOpen(false);
      await load();
      toast.success("Reply sent to Slack");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to send reply";
      toast.error(msg);
    } finally {
      setSending(false);
    }
  };

  // Detect "@query" before the caret as the user types.
  const handleReplyChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setReply(value);
    const caret = e.target.selectionStart ?? value.length;
    const upToCaret = value.slice(0, caret);
    const match = upToCaret.match(/(?:^|\s)@([\w.\-]*)$/);
    if (match) {
      setMentionOpen(true);
      setMentionQuery(match[1] ?? "");
      setMentionStart(caret - (match[1]?.length ?? 0) - 1); // position of '@'
      setMentionIndex(0);
    } else {
      setMentionOpen(false);
    }
  };

  const insertMention = (u: SlackUser) => {
    if (mentionStart === null) return;
    const before = reply.slice(0, mentionStart);
    const caret = textareaRef.current?.selectionStart ?? reply.length;
    const after = reply.slice(caret);
    const inserted = `@${u.name} `;
    const next = before + inserted + after;
    setReply(next);
    setMentionOpen(false);
    setMentionQuery("");
    setMentionStart(null);
    requestAnimationFrame(() => {
      const pos = (before + inserted).length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(pos, pos);
    });
  };

  const formatTs = (ts: string) => {
    try {
      return format(new Date(parseFloat(ts) * 1000), "MMM d, h:mm a");
    } catch {
      return ts;
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col p-0">
        <SheetHeader className="px-6 pt-6 pb-3 border-b border-border">
          <SheetTitle className="flex items-center gap-2">
            <MessagesSquare className="h-4 w-4" />
            {candidateName}
          </SheetTitle>
          <SheetDescription className="flex items-center justify-between gap-2">
            <span className="truncate">Slack thread · {companyName}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
              className="h-7 px-2"
              title="Refresh"
            >
              <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            </Button>
          </SheetDescription>
        </SheetHeader>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {error ? (
            <div className="text-sm text-destructive">{error}</div>
          ) : messages.length === 0 && !loading ? (
            <div className="text-sm text-muted-foreground">No messages found.</div>
          ) : (
            messages.map((m, idx) => (
              <div key={m.ts} className="flex gap-3">
                {m.user_image ? (
                  <img
                    src={m.user_image}
                    alt={m.user_name}
                    className="h-8 w-8 rounded shrink-0"
                  />
                ) : (
                  <div className="h-8 w-8 rounded bg-muted shrink-0 flex items-center justify-center text-xs font-medium">
                    {m.user_name.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {m.user_name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatTs(m.ts)}
                    </span>
                    {idx === 0 && (
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        parent
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-foreground whitespace-pre-wrap break-words mt-0.5">
                    {m.text
                      ? m.text.replace(/<@([A-Z0-9]+)>/g, (_, id) => {
                          const u = users.find((x) => x.id === id);
                          return `@${u?.name ?? id}`;
                        })
                      : <span className="text-muted-foreground italic">(no text)</span>}
                  </div>
                  {m.reactions.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {m.reactions.map((r) => (
                        <span
                          key={r.name}
                          className="text-xs bg-muted px-1.5 py-0.5 rounded"
                        >
                          :{r.name}: {r.count}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="border-t border-border p-4 space-y-2 relative">
          {mentionOpen && filteredUsers.length > 0 && (
            <div className="absolute bottom-full left-4 right-4 mb-2 z-50 max-h-60 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
              {filteredUsers.map((u, i) => (
                <button
                  key={u.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(u);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
                    i === mentionIndex ? "bg-accent" : ""
                  }`}
                >
                  {u.image ? (
                    <img src={u.image} alt={u.name} className="h-6 w-6 rounded" />
                  ) : (
                    <div className="h-6 w-6 rounded bg-muted flex items-center justify-center text-[10px] font-medium">
                      {u.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <span className="font-medium text-foreground">@{u.name}</span>
                  {u.real_name && u.real_name !== u.name && (
                    <span className="text-muted-foreground text-xs truncate">
                      {u.real_name}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <Textarea
            ref={textareaRef}
            value={reply}
            onChange={handleReplyChange}
            placeholder="Reply in this Slack thread... (use @ to mention)"
            rows={3}
            className="resize-none"
            onKeyDown={(e) => {
              if (mentionOpen && filteredUsers.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % filteredUsers.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIndex(
                    (i) => (i - 1 + filteredUsers.length) % filteredUsers.length,
                  );
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  insertMention(filteredUsers[mentionIndex]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMentionOpen(false);
                  return;
                }
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void handleSend();
              }
            }}
          />
          <div className="flex justify-between items-center">
            <span className="text-xs text-muted-foreground">
              @ to mention · ⌘+Enter to send
            </span>
            <Button onClick={() => void handleSend()} disabled={sending || !reply.trim()} size="sm">
              {sending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Send
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
