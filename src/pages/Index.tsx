import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Candidate } from "@/data/candidates";
import { CandidateTable } from "@/components/CandidateTable";
import { DashboardStats } from "@/components/DashboardStats";
import { SearchInput } from "@/components/SearchInput";
import { MultiSelectDropdown } from "@/components/MultiSelectDropdown";
import { CsvUpload } from "@/components/CsvUpload";
import { AshbyFetchButton } from "@/components/AshbyFetchButton";
import { AshbyConnectionBanner } from "@/components/AshbyConnectionBanner";
import { AshbyUserSessionBanner } from "@/components/AshbyUserSessionBanner";
import { AshbyOrgHealthBanner } from "@/components/AshbyOrgHealthBanner";
import { sameCandidateName } from "@shared/pure/nameMatch";
import { normalizeLinkedin } from "@shared/pure/slackText";
import { canonicalCompany } from "@shared/pure/companyMatch";
import { GoogleCalendarSync } from "@/components/GoogleCalendarSync";
import { PostSignInCalendarPrompt } from "@/components/PostSignInCalendarPrompt";
import { SlackConnectButton } from "@/components/SlackConnectButton";
import { SlackThreadPanel } from "@/components/SlackThreadPanel";
import { EmailComposer } from "@/components/EmailComposer";
import { FollowUpBar } from "@/components/FollowUpBar";
import { AgentTab } from "@/components/AgentTab";
import { useAgentCards, visibleCards } from "@/hooks/useAgentCards";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { usePipelineSession } from "@/hooks/usePipelineSession";
import { useAshbySnapshot } from "@/hooks/useAshbySnapshot";
import { useRecruiterAliases } from "@/hooks/useRecruiterAliases";
import { isMine } from "@/lib/recruiterIdentity";
import { useSlackSubmissions } from "@/hooks/useSlackSubmissions";
import { useOnboardingStatus } from "@/hooks/useOnboardingStatus";
import { useAuth } from "@/contexts/AuthContext";
import { Users, Loader2, Clock, LogOut, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  slackStatusToDecision,
  slackStatusToPipelineStage,
} from "@/lib/slackParse";
import { companiesMatch, isAshbyCompany } from "@/lib/companyMatch";

const ONBOARDING_DISMISSED_KEY = "onboardingDismissed";
const PENDING_ONBOARDING_KEY = "pendingOnboarding";

const Index = () => {
  const { candidates, lastUpdated, isLoading, saveSession, markCandidateClosed } = usePipelineSession();
  const { activeSnapshot, archivedSnapshot, orgNames, orgAliases, orgHealth, snapshotLoaded, refreshSnapshot } = useAshbySnapshot();
  const { aliases, aliasesLoaded } = useRecruiterAliases();
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
      onboarding.googleReady && onboarding.slackReady && onboarding.ashbyConnected;
    const isFirstRun =
      pending ||
      (!dismissed && !allConnected && !onboarding.hasCandidates);
    if (isFirstRun) navigate("/onboarding", { replace: true });
  }, [onboarding.loading, onboarding.googleReady, onboarding.slackReady, onboarding.ashbyConnected, onboarding.hasCandidates, navigate]);
  const [search, setSearch] = useState("");
  const [companyFilter, setCompanyFilter] = useState<string[]>([]);
  const [stageFilter, setStageFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [submitterFilter, setSubmitterFilter] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string[]>([]);
  const [slackThreadFor, setSlackThreadFor] = useState<Candidate | null>(null);
  const [emailFor, setEmailFor] = useState<Candidate | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [findingThreadId, setFindingThreadId] = useState<string | null>(null);
  const [ashbyClientNames, setAshbyClientNames] = useState<string[]>([]);
  const [showArchive, setShowArchive] = useState(false);
  const [mineOnly, setMineOnly] = useState(true);

  // The org-shared snapshot (written server-side by ashby-sync) is the Ashby
  // source of truth once it has rows; the per-user candidates table remains
  // as the fallback for CSV uploads and pre-snapshot installs.
  const snapshotIsTruth = snapshotLoaded && (activeSnapshot.length > 0 || archivedSnapshot.length > 0);
  const ashbySourceCandidates = snapshotIsTruth ? activeSnapshot : candidates;

  // Manual-override list of Ashby companies (fed by the Agent tab's
  // "mark as Ashby client" button). The authoritative source is the
  // org-shared ashby_orgs table; this remains as the user escape hatch.
  // Auto-harvest writes from the fetch path were retired in Phase 5.
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
  // Source is COMPANY-level: every row at a client with an Ashby instance is
  // tagged "ashby" (even Slack-only submissions there); clients with no Ashby
  // presence are tagged "slack". A matched Ashby+Slack candidate still gets
  // slack_meta attached so the Thread button works.
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
    for (const c of ashbySourceCandidates) {
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

    // Company-level classification. Primary source: the authoritative
    // ashby_orgs list from the extractor (covers orgs with ZERO candidate
    // rows — candidate-derived sets can never reveal those). Fallbacks: the
    // legacy per-user ashby_known_clients set and companies present in the
    // current Ashby rows.
    // Coverage is DERIVED at render and can shrink: when the org-shared
    // snapshot is the truth, the set is the currently swept org list plus the
    // companies of live real rows (retired rows are already demoted), never
    // the per-user legacy list or archived-only companies — an org that
    // dropped off the access list must stop counting as Ashby-covered.
    const ashbyCompanySet = new Set<string>(
      snapshotIsTruth ? [...orgNames] : [...orgNames, ...ashbyClientNames],
    );
    for (const c of ashbySourceCandidates) {
      const name = canonicalCompany((c.company_name ?? "").trim(), orgAliases);
      if (name) ashbyCompanySet.add(name);
    }
    if (!snapshotIsTruth) {
      for (const c of archivedSnapshot) {
        const name = (c.company_name ?? "").trim();
        if (name) ashbyCompanySet.add(name);
      }
    }
    const companyIsAshby = (companyName: string): boolean =>
      isAshbyCompany(companyName, ashbyCompanySet);

    // Match Ashby rows to Slack submissions by IDENTITY: the LinkedIn URL
    // when both sides carry one, else the nickname-tolerant name match
    // ("Dan Clark" ≡ "Daniel Clark", "Zhaohan (Robert) Hu" ≡ "Robert (Zhaohan)
    // Hu"). Always with a fuzzy company match — a candidate may be in several
    // pipelines and each row should only show its own thread.
    const samePerson = (
      s: (typeof slackSubs)[number],
      name: string,
      linkedin?: string | null,
    ): boolean => {
      const a = normalizeLinkedin(s.linkedin_url ?? "");
      const b = normalizeLinkedin(linkedin ?? "");
      if (a && b) return a === b;
      return sameCandidateName(s.candidate_name || "", name);
    };

    const matchedSlackIds = new Set<string>();
    const enriched: Candidate[] = ashbySourceCandidates.map((c) => {
      const matches = slackSubs
        .filter((s) => !matchedSlackIds.has(s.id))
        .filter((s) => companiesMatch(canonicalCompany(s.client_name, orgAliases), c.company_name))
        .filter((s) => samePerson(s, c.candidate_name, c.linkedin_url))
        .sort(
          (a, b) =>
            new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime(),
        );
      const slack = matches[0];
      if (slack) {
        matchedSlackIds.add(slack.id);
        return {
          ...c,
          source: "ashby",
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

    // A Slack thread whose candidate is ARCHIVED in Ashby should not
    // resurface as an active Slack-only row (or a false "missing from
    // Ashby" flag) — the archived snapshot row already represents that loop
    // and is visible under the archive toggle.
    // Only DONE rows demote a Slack loop; a retired org says nothing about
    // the candidate, so its (demoted) rows must not hide the Slack thread.
    const doneSnapshot = archivedSnapshot.filter((a) => a.org_status !== "retired");
    const matchesArchived = (s: (typeof slackSubs)[number]): boolean =>
      doneSnapshot.some(
        (a) =>
          companiesMatch(canonicalCompany(s.client_name, orgAliases), a.company_name) &&
          samePerson(s, a.candidate_name, a.linkedin_url),
      );

    const slackOnly: Candidate[] = slackSubs
      .filter((s) => !matchedSlackIds.has(s.id))
      .filter((s) => !matchesArchived(s))
      .map((s) => {
        // Slack-only candidate: no Ashby record for THIS person, so we don't
        // know their real pipeline progress — total_stages 0 renders as "—"
        // and sorts below every real progress value. The source tag still
        // follows the COMPANY: a loop at an Ashby-instrumented client is
        // "ashby" even when this particular row only exists in Slack.
        const isAshby = companyIsAshby(s.client_name);
        return {
          company_name: s.client_name,
          job_title: "—",
          job_id: `slack:${s.channel_id}`,
          candidate_name: s.candidate_name || "(name needs review)",
          candidate_id: `slack:${s.channel_id}:${s.message_ts}`,
          pipeline_stage: slackStatusToPipelineStage(s.status),
          decision_status: slackStatusToDecision(s.status),
          stage_type: "",
          current_stage_index: 0,
          total_stages: 0,
          stage_progress: "",
          last_activity_at: s.submitted_at,
          days_in_stage: Math.max(
            0,
            Math.floor((Date.now() - new Date(s.submitted_at).getTime()) / 86_400_000),
          ),
          needs_scheduling: false,
          credited_to: userLabel,
          source: isAshby ? "ashby" : "slack",
          // Flag the gap: this person is in a Slack thread at an
          // Ashby-instrumented client but has no Ashby record yet.
          missing_from_ashby: isAshby,
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
  }, [ashbySourceCandidates, archivedSnapshot, slackSubs, user?.email, ashbyClientNames, orgNames, orgAliases, snapshotIsTruth]);

  // Per-user view + archive split, applied AFTER the merge so both respect
  // the same identity rules. "My candidates" filters the org-shared data to
  // rows credited to this user's aliases; archived rows appear only behind
  // the toggle and never count toward stats.
  const visibleCandidates = useMemo(() => {
    const mineFilter = (list: Candidate[]) =>
      mineOnly ? list.filter((c) => isMine(c, user?.email, aliases)) : list;
    const active = mineFilter(mergedCandidates);
    const archived = showArchive && snapshotIsTruth ? mineFilter(archivedSnapshot) : [];
    return { active, archived, all: [...active, ...archived] };
  }, [mergedCandidates, archivedSnapshot, mineOnly, aliases, showArchive, snapshotIsTruth, user?.email]);

  const companies = useMemo(
    () => [...new Set(visibleCandidates.all.map((c) => c.company_name))].sort(),
    [visibleCandidates],
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
    () => [...new Set(visibleCandidates.all.map((c) => c.decision_status))].sort(),
    [visibleCandidates],
  );

  const submitters = useMemo(
    () => [...new Set(visibleCandidates.all.map((c) => c.credited_to))].sort(),
    [visibleCandidates],
  );

  const sources = useMemo(
    () => [...new Set(visibleCandidates.all.map((c) => c.source || "ashby"))].sort(),
    [visibleCandidates],
  );

  const filteredCandidates = useMemo(() => {
    return visibleCandidates.all.filter((candidate) => {
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
  }, [visibleCandidates, search, companyFilter, stageFilter, statusFilter, submitterFilter, sourceFilter]);

  // Shared by the table's ⛔ button and the follow-up bar's batch close.
  // Returns success so the batch path can count failures.
  const closeCandidate = async (c: Candidate): Promise<boolean> => {
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
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Slack reaction failed";
        toast.error(`Closed locally, but Slack reaction failed: ${msg}`);
        return false;
      }
    }
    toast.success(`${c.candidate_name} closed`);
    return true;
  };

  const toggleSelect = (c: Candidate) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(c.candidate_id)) next.delete(c.candidate_id);
      else next.add(c.candidate_id);
      return next;
    });
  };

  const selectedCandidates = visibleCandidates.all.filter((c) =>
    selectedIds.has(c.candidate_id),
  );

  const deselectChannel = (channelId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const c of visibleCandidates.all) {
        if (c.slack_meta?.channel_id === channelId) next.delete(c.candidate_id);
      }
      return next;
    });
  };

  // Open a candidate's Slack thread; when no submission link is stored, fall
  // back to a live lookup via Slack search (slack-thread action=find).
  const openSlackThread = async (c: Candidate) => {
    if (c.slack_meta?.channel_id && c.slack_meta?.message_ts) {
      setSlackThreadFor(c);
      return;
    }
    setFindingThreadId(c.candidate_id);
    try {
      const { data, error } = await supabase.functions.invoke("slack-thread", {
        body: {
          action: "find",
          candidate_name: c.candidate_name,
          company_name: c.company_name,
        },
      });
      if (error) {
        const ctx = (error as { context?: Response }).context;
        if (ctx && typeof ctx.json === "function") {
          const body = await ctx.json().catch(() => null);
          if (body?.error) throw new Error(body.error);
        }
        throw error;
      }
      if (data?.error) throw new Error(data.error);
      if (!data?.found) {
        toast.info(`No Slack thread found for ${c.candidate_name}`);
        return;
      }
      setSlackThreadFor({
        ...c,
        slack_meta: {
          status: "submitted",
          submitted_at: c.last_activity_at,
          channel_id: data.channel_id,
          message_ts: data.message_ts,
          linkedin_url: null,
          needs_review: false,
        },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Thread lookup failed");
    } finally {
      setFindingThreadId(null);
    }
  };

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
                  {(orgHealth?.checked_at || lastUpdated) && (
                    <span
                      className="flex items-center gap-1 text-xs"
                      title={orgHealth?.checked_at ? "When the team's Ashby snapshot was last saved" : "Last CSV import"}
                    >
                      <Clock className="h-3 w-3" />
                      {orgHealth?.checked_at ? "Ashby synced" : "Last imported"}:{" "}
                      {new Date(orgHealth?.checked_at ?? lastUpdated!).toLocaleDateString()}{" "}
                      {new Date(orgHealth?.checked_at ?? lastUpdated!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <GoogleCalendarSync candidates={filteredCandidates} />
              <SlackConnectButton onSynced={reloadSlack} />
              <AshbyFetchButton
                onSyncComplete={async () => {
                  // The server persisted the org-shared snapshot during the
                  // poll — re-pull it so the table reflects the new truth.
                  await refreshSnapshot();
                }}
              />
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
        <AshbyConnectionBanner />
        <AshbyUserSessionBanner />
        <AshbyOrgHealthBanner audit={orgHealth} onChanged={refreshSnapshot} />
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
                {/* Stats — active loops only; archived rows never count. */}
                <DashboardStats candidates={visibleCandidates.active} />

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
                    {aliasesLoaded && aliases.length > 0 && (
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={mineOnly}
                          onChange={(e) => setMineOnly(e.target.checked)}
                          className="h-3.5 w-3.5 accent-primary"
                        />
                        My candidates only
                      </label>
                    )}
                    {snapshotIsTruth && archivedSnapshot.length > 0 && (
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={showArchive}
                          onChange={(e) => setShowArchive(e.target.checked)}
                          className="h-3.5 w-3.5 accent-primary"
                        />
                        Include archive ({archivedSnapshot.length})
                      </label>
                    )}
                  </div>
                </div>

                {/* Results count */}
                <p className="text-sm text-muted-foreground">
                  Showing {filteredCandidates.length} of {visibleCandidates.all.length} candidates
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
                  onOpenSlackThread={(c) => void openSlackThread(c)}
                  onOpenEmail={(c) => setEmailFor(c)}
                  onCloseCandidate={(c) => void closeCandidate(c)}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  findingThreadId={findingThreadId}
                />

                <FollowUpBar
                  selected={selectedCandidates}
                  onClear={() => setSelectedIds(new Set())}
                  onDeselectChannel={deselectChannel}
                  onCloseCandidate={closeCandidate}
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
