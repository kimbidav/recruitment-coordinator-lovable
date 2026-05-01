import { useState, useMemo } from "react";
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
import { usePipelineSession } from "@/hooks/usePipelineSession";
import { useSlackSubmissions } from "@/hooks/useSlackSubmissions";
import { useAuth } from "@/contexts/AuthContext";
import { Users, Loader2, Clock, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  candidateMatchKey,
  slackStatusToDecision,
  slackStatusToPipelineStage,
} from "@/lib/slackParse";

const Index = () => {
  const { candidates, lastUpdated, isLoading, saveSession } = usePipelineSession();
  const { submissions: slackSubs, reload: reloadSlack } = useSlackSubmissions();
  const { user, signOut } = useAuth();
  const [search, setSearch] = useState("");
  const [companyFilter, setCompanyFilter] = useState<string[]>([]);
  const [stageFilter, setStageFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [submitterFilter, setSubmitterFilter] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string[]>([]);

  const handleCsvUpload = (uploadedCandidates: Candidate[]) => {
    saveSession(uploadedCandidates);
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
    const ashbyByKey = new Map<string, Candidate>();
    for (const c of candidates) {
      ashbyByKey.set(candidateMatchKey(c.company_name, c.candidate_name), c);
    }

    const matchedSlackKeys = new Set<string>();
    const enriched: Candidate[] = candidates.map((c) => {
      const key = candidateMatchKey(c.company_name, c.candidate_name);
      const slack = slackSubs.find(
        (s) => candidateMatchKey(s.client_name, s.candidate_name) === key,
      );
      if (slack) {
        matchedSlackKeys.add(key);
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
      return { ...c, source: c.source || "ashby" };
    });

    const slackOnly: Candidate[] = slackSubs
      .filter((s) => {
        const k = candidateMatchKey(s.client_name, s.candidate_name);
        return !matchedSlackKeys.has(k) && !ashbyByKey.has(k);
      })
      .map((s) => ({
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
      }));

    return [...enriched, ...slackOnly];
  }, [candidates, slackSubs, user?.email]);

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
        {mergedCandidates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="p-4 bg-muted rounded-full mb-4">
              <Users className="h-8 w-8 text-muted-foreground" />
            </div>
            <h2 className="text-xl font-semibold text-foreground mb-2">No candidates yet</h2>
            <p className="text-muted-foreground mb-6 max-w-md">
              Connect Ashby or Slack, or upload a CSV, to start populating your pipeline.
            </p>
            <CsvUpload onUpload={handleCsvUpload} />
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
                setCompanyFilter([]);
                setStageFilter([]);
                setStatusFilter([]);
                setSubmitterFilter([]);
                setSourceFilter([]);
              }}
            />
          </>
        )}
      </main>
    </div>
  );
};

export default Index;
