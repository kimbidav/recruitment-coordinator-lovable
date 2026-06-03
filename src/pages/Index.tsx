import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Candidate } from "@/data/candidates";
import { CandidateTable } from "@/components/CandidateTable";
import { DashboardStats } from "@/components/DashboardStats";
import { SearchInput } from "@/components/SearchInput";
import { MultiSelectDropdown } from "@/components/MultiSelectDropdown";
import { CsvUpload } from "@/components/CsvUpload";
import { AshbyFetchButton } from "@/components/AshbyFetchButton";
import { GoogleCalendarSync } from "@/components/GoogleCalendarSync";
import { PostSignInCalendarPrompt } from "@/components/PostSignInCalendarPrompt";
import { SlackConnectButton } from "@/components/SlackConnectButton";
import { SlackThreadPanel } from "@/components/SlackThreadPanel";
import { EmailComposer } from "@/components/EmailComposer";
import { AgentTab } from "@/components/AgentTab";
import { useAgentCards, visibleCards } from "@/hooks/useAgentCards";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { usePipelineSession } from "@/hooks/usePipelineSession";
import { useSlackSubmissions } from "@/hooks/useSlackSubmissions";
import { useOnboardingStatus } from "@/hooks/useOnboardingStatus";
import { useAuth } from "@/contexts/AuthContext";
import { Users, Loader2, Clock, LogOut, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  normalizeMatchKey,
  slackStatusToDecision,
  slackStatusToPipelineStage,
} from "@/lib/slackParse";
import { companiesMatch, isAshbyCompany } from "@/lib/companyMatch";

const ONBOARDING_DISMISSED_KEY = "onboardingDismissed";
const PENDING_ONBOARDING_KEY = "pendingOnboarding";

const Index = () => {
  const { candidates, lastUpdated, isLoading, saveSession, markCandidateClosed } = usePipelineSession();
  const { submissions: slackSubs, reload: reloadSlack } = useSlackSubmissions();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const onboarding = useOnboardingStatus();
  const { cards: agentCards } = useAgentCards();
  const agentOpenCount = useMemo(() => visibleCards(agentCards).length, [agentCards]);
  const [activeTab, setActiveTab] = useState<string>("pipeline");

  // First-run redirect: brand-new users land on /onboarding instead of an
  // empty dashboard. Honors a "skip for now" dismissal.
  useEffect(() => {
    if (onboarding.loading) return;
    const dismissed = localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1";
    const pending = sessionStorage.getItem(PENDING_ONBOARDING_KEY) === "1";
    const allConnected =
      onboarding.googleConnected && onboarding.slackConnected && onboarding.ashbyConnected;
    const isFirstRun =
      pending ||
      (!dismissed && !allConnected && !onboarding.hasCandidates);
    if (isFirstRun) navigate("/onboarding", { replace: true });
  }, [onboarding.loading, onboarding.googleConnected, onboarding.slackConnected, onboarding.ashbyConnected, onboarding.hasCandidates, navigate]);
  const [search, setSearch] = useState("");
  const [companyFilter, setCompanyFilter] = useState<string[]>([]);
  const [stageFilter, setStageFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [submitterFilter, setSubmitterFilter] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string[]>([]);
  const [slackThreadFor, setSlackThreadFor] = useState<Candidate | null>(null);
  const [emailFor, setEmailFor] = useState<Candidate | null>(null);
  const [ashbyClientNames, setAshbyClientNames] = useState<string[]>([]);

  // Load the authoritative set of companies known to exist in the user's Ashby
  // workspace. This is cumulative across every past fetch — never deleted —
  // so a company stays "Ashby" even if it has zero active candidates today.
  useEffect(() => {
    if (!user) {
      setAshbyClientNames([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("ashby_known_clients")
        .select("client_name")
        .eq("user_id", user.id);
      if (cancelled) return;
      if (error) {
        console.warn("Failed to load ashby_known_clients:", error.message);
        setAshbyClientNames([]);
        return;
      }
      setAshbyClientNames((data ?? []).map((r) => r.client_name).filter(Boolean));
    })();
    return () => {
      cancelled = true;
    };
    // Re-pull after each save (lastUpdated changes when saveSession finishes).
  }, [user?.id, lastUpdated]);

  const handleCsvUpload = (
    uploadedCandidates: Candidate[],
    options?: { deleteMissing?: boolean },
  ) => {
    saveSession(uploadedCandidates, options);
    setCompanyFilter([]);
    setStageFilter([]);
    setStatusFilter([]);
    setSubmitterFilter([]);
    setSourceFilter([]);
    setSearch("");
  };

  // Merge Ashby candidates with Slack submissions.
  // Match key = normalized(client_name) + normalized(candidate_name).
  // - Ashby + Slack match -> single Ashby row, slack_meta attached, source="both"
  // - Ashby only -> source="ashby"
  // - Slack only -> synthesize a Candidate row, source="slack"
  const mergedCandidates = useMemo<Candidate[]>(() => {
    // Build a lookup of "name-ish tokens" -> canonical display name from Ashby
    // credited_to values, so Slack rows (credited under email) collapse onto the
    // same submitter as Ashby rows for the same person.
    const tokenize = (s: string) =>
      s
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean);

    const canonicalByToken = new Map<string, string>();
    for (const c of candidates) {
      const name = c.credited_to?.trim();
      if (!name || name.includes("@")) continue;
      const tokens = tokenize(name);
      // Map full normalized name + each token (first/last) to the display name.
      canonicalByToken.set(tokens.join(" "), name);
      for (const t of tokens) {
        if (t.length >= 2 && !canonicalByToken.has(t)) {
          canonicalByToken.set(t, name);
        }
      }
    }

    const canonicalizeSubmitter = (raw: string): string => {
      if (!raw) return raw;
      const trimmed = raw.trim();
      // If it's an email, derive tokens from local-part (e.g. "dkimball" or "david.kimball").
      if (trimmed.includes("@")) {
        const local = trimmed.split("@")[0];
        const parts = local.split(/[._\-+]/).filter(Boolean);
        // Try full local-part joined, then individual parts.
        const candidates = [parts.join(" "), ...parts, local];
        for (const cand of candidates) {
          const hit = canonicalByToken.get(cand.toLowerCase());
          if (hit) return hit;
        }
        // Also try matching by first-letter + remainder (e.g. "dkimball" -> "kimball").
        if (parts.length === 1 && local.length > 2) {
          const tail = local.slice(1);
          const hit = canonicalByToken.get(tail);
          if (hit) return hit;
        }
        return trimmed;
      }
      const hit = canonicalByToken.get(tokenize(trimmed).join(" "));
      return hit ?? trimmed;
    };

    const userLabel = canonicalizeSubmitter(user?.email ?? "Me");

    // Company-level classification driven by the authoritative ashby_known_clients
    // set (cumulative across every past fetch). Every distinct company across
    // Ashby + Slack is either an "Ashby company" or a "Slack-only company".
    // Per-candidate source then inherits from the company, with an override:
    // a candidate seen in BOTH the Ashby fetch and a Slack thread is tagged "both".
    const ashbyCompanySet = new Set<string>(ashbyClientNames);
    // Also treat any company currently returned from the Ashby fetch as Ashby,
    // even if ashby_known_clients hasn't been refreshed yet on this page load.
    for (const c of candidates) {
      const name = (c.company_name ?? "").trim();
      if (name) ashbyCompanySet.add(name);
    }
    const companyIsAshby = (companyName: string): boolean =>
      isAshbyCompany(companyName, ashbyCompanySet);

    // Build candidate-name -> [slack rows] indexes, then match Ashby rows that
    // share BOTH a name (fuzzy) AND a fuzzy company-key match. We do NOT
    // attach Slack threads across companies — a candidate may be in multiple
    // pipelines and each row should only show its own thread.
    //
    // Name matching is intentionally fuzzy: people often appear in Slack with
    // their full legal name and in Ashby with a short form, or vice versa.
    const nameTokens = (s: string): string[] =>
      normalizeMatchKey(s || "")
        .split(" ")
        .filter((t) => t.length > 0);
    const firstLastKey = (s: string): string | null => {
      const toks = nameTokens(s);
      if (toks.length < 2) return null;
      return `${toks[0]}::${toks[toks.length - 1]}`;
    };
    const initialLastKey = (s: string): string | null => {
      const toks = nameTokens(s);
      if (toks.length < 2) return null;
      return `${toks[0][0]}::${toks[toks.length - 1]}`;
    };

    const slackByCandidateName = new Map<string, typeof slackSubs>();
    const slackByFirstLast = new Map<string, typeof slackSubs>();
    const slackByInitialLast = new Map<string, typeof slackSubs>();
    const pushInto = (
      m: Map<string, typeof slackSubs>,
      key: string | null,
      s: (typeof slackSubs)[number],
    ) => {
      if (!key) return;
      const arr = m.get(key) ?? [];
      arr.push(s);
      m.set(key, arr);
    };
    for (const s of slackSubs) {
      const nameKey = normalizeMatchKey(s.candidate_name || "");
      if (nameKey) pushInto(slackByCandidateName, nameKey, s);
      pushInto(slackByFirstLast, firstLastKey(s.candidate_name || ""), s);
      pushInto(slackByInitialLast, initialLastKey(s.candidate_name || ""), s);
    }

    const matchedSlackIds = new Set<string>();
    const enriched: Candidate[] = candidates.map((c) => {
      const buckets: (typeof slackSubs)[] = [
        slackByCandidateName.get(normalizeMatchKey(c.candidate_name)) ?? [],
        slackByFirstLast.get(firstLastKey(c.candidate_name) ?? "") ?? [],
        slackByInitialLast.get(initialLastKey(c.candidate_name) ?? "") ?? [],
      ];
      const seen = new Set<string>();
      const pool = buckets.flat().filter((s) => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
      });
      const matches = pool
        .filter((s) => companiesMatch(s.client_name, c.company_name))
        .filter((s) => !matchedSlackIds.has(s.id))
        .sort(
          (a, b) =>
            new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime(),
        );
      const slack = matches[0];
      if (slack) {
        matchedSlackIds.add(slack.id);
        return {
          ...c,
          source: "both",
          slack_meta: {
            status: slack.status,
            submitted_at: slack.submitted_at,
            channel_id: slack.channel_id,
            message_ts: slack.message_ts,
            linkedin_url: slack.linkedin_url,
            needs_review: slack.needs_review,
          },
        };
      }
      // Ashby fetch row with no Slack match → "ashby" (company is Ashby by definition).
      return { ...c, source: "ashby" };
    });

    const slackOnly: Candidate[] = slackSubs
      .filter((s) => !matchedSlackIds.has(s.id))
      .map((s) => {
        // Slack-only candidate. If the COMPANY exists in Ashby (per
        // ashby_known_clients), we still surface it but the per-candidate
        // source stays "slack" because we have no Ashby record for THIS
        // person. Other rows for the same company will be tagged "ashby"
        // or "both", so the company-level classification reads correctly.
        const _isAshby = companyIsAshby(s.client_name);
        return {
          company_name: s.client_name,
          job_title: "—",
          job_id: `slack:${s.channel_id}`,
          candidate_name: s.candidate_name || "(name needs review)",
          candidate_id: `slack:${s.channel_id}:${s.message_ts}`,
          pipeline_stage: slackStatusToPipelineStage(s.status),
          decision_status: slackStatusToDecision(s.status),
          stage_type: "",
          current_stage_index: s.status === "accepted" ? 1 : 0,
          total_stages: 1,
          stage_progress: s.status === "accepted" ? "1/1" : "0/1",
          last_activity_at: s.submitted_at,
          days_in_stage: Math.max(
            0,
            Math.floor((Date.now() - new Date(s.submitted_at).getTime()) / 86_400_000),
          ),
          needs_scheduling: false,
          credited_to: userLabel,
          source: "slack",
          feedback_count: 0,
          slack_meta: {
            status: s.status,
            submitted_at: s.submitted_at,
            channel_id: s.channel_id,
            message_ts: s.message_ts,
            linkedin_url: s.linkedin_url,
            needs_review: s.needs_review,
          },
        };
      });

    return [...enriched, ...slackOnly];
  }, [candidates, slackSubs, user?.email, ashbyClientNames]);

  const companies = useMemo(
    () => [...new Set(mergedCandidates.map((c) => c.company_name))].sort(),
    [mergedCandidates],
  );

  // Collapse granular pipeline stages into two buckets the user cares about:
  // "In Process" (still active) vs "Closed" (rejected / withdrawn / not in process / hired).
  const stageBucket = (c: Candidate): "In Process" | "Closed" => {
    if (c.closed_locally) return "Closed";
    const decision = (c.decision_status || "").toLowerCase();
    const stage = (c.pipeline_stage || "").toLowerCase();
    const closedDecision = ["rejected", "withdrawn", "archived", "hired", "closed"].some((k) =>
      decision.includes(k),
    );
    const closedStage = ["disqualified", "not in process", "rejected", "withdrawn", "hired", "archived"].some(
      (k) => stage.includes(k),
    );
    return closedDecision || closedStage ? "Closed" : "In Process";
  };

  const stages = useMemo(() => ["In Process", "Closed"], []);

  const statuses = useMemo(
    () => [...new Set(mergedCandidates.map((c) => c.decision_status))].sort(),
    [mergedCandidates],
  );

  const submitters = useMemo(
    () => [...new Set(mergedCandidates.map((c) => c.credited_to))].sort(),
    [mergedCandidates],
  );

  const sources = useMemo(
    () => [...new Set(mergedCandidates.map((c) => c.source || "ashby"))].sort(),
    [mergedCandidates],
  );

  const filteredCandidates = useMemo(() => {
    return mergedCandidates.filter((candidate) => {
      const matchesSearch =
        search === "" ||
        candidate.candidate_name.toLowerCase().includes(search.toLowerCase()) ||
        candidate.company_name.toLowerCase().includes(search.toLowerCase()) ||
        candidate.job_title.toLowerCase().includes(search.toLowerCase()) ||
        candidate.credited_to.toLowerCase().includes(search.toLowerCase());

      const matchesCompany =
        companyFilter.length === 0 || companyFilter.includes(candidate.company_name);
      const matchesStage =
        stageFilter.length === 0 || stageFilter.includes(stageBucket(candidate));
      const matchesStatus =
        statusFilter.length === 0 || statusFilter.includes(candidate.decision_status);
      const matchesSubmitter =
        submitterFilter.length === 0 || submitterFilter.includes(candidate.credited_to);
      const matchesSource =
        sourceFilter.length === 0 || sourceFilter.includes(candidate.source || "ashby");

      return (
        matchesSearch &&
        matchesCompany &&
        matchesStage &&
        matchesStatus &&
        matchesSubmitter &&
        matchesSource
      );
    });
  }, [mergedCandidates, search, companyFilter, stageFilter, statusFilter, submitterFilter, sourceFilter]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading pipeline...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <PostSignInCalendarPrompt />
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container py-4">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary rounded-lg">
                <Users className="h-5 w-5 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-foreground">Candidate Pipeline</h1>
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <span>Track and manage your hiring pipeline</span>
                  {lastUpdated && (
                    <span className="flex items-center gap-1 text-xs">
                      <Clock className="h-3 w-3" />
                      Last imported: {new Date(lastUpdated).toLocaleDateString()}{" "}
                      {new Date(lastUpdated).toLocaleTimeString()}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <GoogleCalendarSync candidates={filteredCandidates} />
              <SlackConnectButton onSynced={reloadSlack} />
              <AshbyFetchButton onUpload={handleCsvUpload} />
              <CsvUpload onUpload={handleCsvUpload} />
              {user && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={signOut}
                  className="gap-2"
                  title={user.email ?? "Sign out"}
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </Button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container py-6 space-y-6">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList>
            <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
            <TabsTrigger value="agent" className="gap-2">
              Agent
              {agentOpenCount > 0 && (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  {agentOpenCount}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pipeline" className="space-y-6 mt-0">
            {mergedCandidates.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="p-4 bg-muted rounded-full mb-4">
                  <Users className="h-8 w-8 text-muted-foreground" />
                </div>
                <h2 className="text-xl font-semibold text-foreground mb-2">No candidates yet</h2>
                <p className="text-muted-foreground mb-6 max-w-md">
                  Finish connecting Ashby and Slack to start populating your pipeline — or upload a CSV.
                </p>
                <div className="flex items-center gap-3">
                  <Button onClick={() => navigate("/onboarding")} className="gap-2">
                    <Sparkles className="h-4 w-4" />
                    Finish setup
                  </Button>
                  <CsvUpload onUpload={handleCsvUpload} />
                </div>
              </div>
            ) : (
              <>
                {/* Stats */}
                <DashboardStats candidates={mergedCandidates} />

                {/* Filters */}
                <div className="flex flex-col sm:flex-row gap-3">
                  <SearchInput
                    value={search}
                    onChange={setSearch}
                    placeholder="Search candidates, companies, roles..."
                    className="flex-1 max-w-md"
                  />
                  <div className="flex gap-3 flex-wrap">
                    <MultiSelectDropdown
                      values={companyFilter}
                      onChange={setCompanyFilter}
                      options={companies}
                      placeholder="Company"
                      allLabel="All Companies"
                      className="w-[160px]"
                    />
                    <MultiSelectDropdown
                      values={submitterFilter}
                      onChange={setSubmitterFilter}
                      options={submitters}
                      placeholder="Submitted By"
                      allLabel="All Submitters"
                      className="w-[160px]"
                    />
                    <MultiSelectDropdown
                      values={stageFilter}
                      onChange={setStageFilter}
                      options={stages}
                      placeholder="Stage"
                      allLabel="All Stages"
                      className="w-[200px]"
                    />
                    <MultiSelectDropdown
                      values={statusFilter}
                      onChange={setStatusFilter}
                      options={statuses}
                      placeholder="Status"
                      allLabel="All Statuses"
                      className="w-[180px]"
                    />
                    {sources.length > 1 && (
                      <MultiSelectDropdown
                        values={sourceFilter}
                        onChange={setSourceFilter}
                        options={sources}
                        placeholder="Source"
                        allLabel="All Sources"
                        className="w-[140px]"
                      />
                    )}
                  </div>
                </div>

                {/* Results count */}
                <p className="text-sm text-muted-foreground">
                  Showing {filteredCandidates.length} of {mergedCandidates.length} candidates
                  {slackSubs.length > 0 && (
                    <span className="ml-2">
                      · {slackSubs.length} from Slack
                    </span>
                  )}
                </p>

                {/* Table */}
                <CandidateTable
                  candidates={filteredCandidates}
                  onFilterByCandidate={(name) => {
                    setSearch(name);
                  }}
                  onOpenSlackThread={(c) => setSlackThreadFor(c)}
                  onOpenEmail={(c) => setEmailFor(c)}
                  onCloseCandidate={async (c) => {
                    await markCandidateClosed(c.candidate_id, c.job_id, true);
                    if (c.slack_meta?.channel_id && c.slack_meta?.message_ts) {
                      try {
                        const { data, error } = await supabase.functions.invoke("slack-thread", {
                          body: {
                            action: "close",
                            channel_id: c.slack_meta.channel_id,
                            message_ts: c.slack_meta.message_ts,
                          },
                        });
                        if (error) throw error;
                        if (data?.error) throw new Error(data.error);
                        toast.success(`${c.candidate_name} closed · ⛔ added in Slack`);
                      } catch (e) {
                        const msg = e instanceof Error ? e.message : "Slack reaction failed";
                        toast.error(`Closed locally, but Slack reaction failed: ${msg}`);
                      }
                    } else {
                      toast.success(`${c.candidate_name} closed`);
                    }
                  }}
                />
              </>
            )}
          </TabsContent>

          <TabsContent value="agent" className="mt-0">
            <AgentTab />
          </TabsContent>
        </Tabs>
      </main>

      <SlackThreadPanel
        open={!!slackThreadFor}
        onOpenChange={(o) => !o && setSlackThreadFor(null)}
        channelId={slackThreadFor?.slack_meta?.channel_id ?? null}
        messageTs={slackThreadFor?.slack_meta?.message_ts ?? null}
        candidateName={slackThreadFor?.candidate_name ?? ""}
        companyName={slackThreadFor?.company_name ?? ""}
      />

      <EmailComposer
        open={!!emailFor}
        onOpenChange={(o) => !o && setEmailFor(null)}
        candidateName={emailFor?.candidate_name ?? ""}
        opportunities={
          emailFor
            ? mergedCandidates.filter((c) => c.candidate_name === emailFor.candidate_name)
            : []
        }
      />
    </div>
  );
};

export default Index;
