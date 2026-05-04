import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

interface ScanItem {
  id: string;
  slack_submission_id: string | null;
  candidate_name: string | null;
  client_name: string | null;
  outcome: string;
  reason: string | null;
  signal: Record<string, unknown> | null;
  created_at: string;
}

const OUTCOME_LABEL: Record<string, string> = {
  card_created: "Card created",
  card_updated: "Card updated",
  no_signal_needed: "No card",
  too_recent: "Too recent",
  skipped_no_name: "Skipped",
  error: "Error",
};

const OUTCOME_COLOR: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  card_created: "default",
  card_updated: "secondary",
  no_signal_needed: "outline",
  too_recent: "outline",
  skipped_no_name: "outline",
  error: "destructive",
};

interface Props {
  runId: string | null;
}

export function AgentScanDiagnostics({ runId }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ScanItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    if (!open || !runId) return;
    setLoading(true);
    void (async () => {
      const { data, error } = await supabase
        .from("agent_scan_items")
        .select("*")
        .eq("scan_run_id", runId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (!error) setItems((data ?? []) as unknown as ScanItem[]);
      setLoading(false);
    })();
  }, [open, runId]);

  if (!runId) return null;

  const outcomes = Array.from(new Set(items.map((i) => i.outcome)));
  const filtered = filter === "all" ? items : items.filter((i) => i.outcome === filter);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border border-border rounded-lg">
      <CollapsibleTrigger asChild>
        <button className="w-full flex items-center justify-between p-3 text-sm text-muted-foreground hover:text-foreground">
          <span className="flex items-center gap-2">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Scan diagnostics
          </span>
          <span className="text-xs">{items.length > 0 ? `${items.length} items` : "show last run details"}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3 space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading...
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No items recorded for the last scan.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant={filter === "all" ? "default" : "outline"}
                onClick={() => setFilter("all")}
                className="h-7 text-xs"
              >
                All ({items.length})
              </Button>
              {outcomes.map((o) => (
                <Button
                  key={o}
                  size="sm"
                  variant={filter === o ? "default" : "outline"}
                  onClick={() => setFilter(o)}
                  className="h-7 text-xs"
                >
                  {OUTCOME_LABEL[o] ?? o} ({items.filter((i) => i.outcome === o).length})
                </Button>
              ))}
            </div>
            <div className="divide-y divide-border max-h-96 overflow-auto rounded border border-border">
              {filtered.map((it) => (
                <div key={it.id} className="p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground truncate">
                      {it.candidate_name || "(no name)"}{" "}
                      <span className="text-muted-foreground">· {it.client_name}</span>
                    </span>
                    <Badge variant={OUTCOME_COLOR[it.outcome] ?? "outline"} className="shrink-0">
                      {OUTCOME_LABEL[it.outcome] ?? it.outcome}
                    </Badge>
                  </div>
                  {it.reason && (
                    <p className="text-muted-foreground mt-0.5 line-clamp-2">{it.reason}</p>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
