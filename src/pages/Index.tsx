import { useState, useMemo } from "react";
import { Candidate } from "@/data/candidates";
import { CandidateTable } from "@/components/CandidateTable";
import { DashboardStats } from "@/components/DashboardStats";
import { SearchInput } from "@/components/SearchInput";
import { MultiSelectDropdown } from "@/components/MultiSelectDropdown";
import { CsvUpload } from "@/components/CsvUpload";
import { AshbyFetchButton } from "@/components/AshbyFetchButton";
import { GoogleCalendarSync } from "@/components/GoogleCalendarSync";
import { usePipelineSession } from "@/hooks/usePipelineSession";
import { Users, Share2, Loader2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

const Index = () => {
  const { candidates, sessionId, lastUpdated, isLoading, saveSession, clearSession } = usePipelineSession();
  const [search, setSearch] = useState("");
  const [companyFilter, setCompanyFilter] = useState<string[]>([]);
  const [stageFilter, setStageFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [submitterFilter, setSubmitterFilter] = useState<string[]>([]);

  const handleCsvUpload = (uploadedCandidates: Candidate[]) => {
    saveSession(uploadedCandidates);
    // Reset filters when new data is loaded
    setCompanyFilter([]);
    setStageFilter([]);
    setStatusFilter([]);
    setSubmitterFilter([]);
    setSearch("");
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    toast.success("Link copied to clipboard!");
  };

  const companies = useMemo(() => 
    [...new Set(candidates.map(c => c.company_name))].sort(),
    [candidates]
  );
  
  const stages = useMemo(() => 
    [...new Set(candidates.map(c => c.pipeline_stage))].sort(),
    [candidates]
  );
  
  const statuses = useMemo(() => 
    [...new Set(candidates.map(c => c.decision_status))].sort(),
    [candidates]
  );

  const submitters = useMemo(() => 
    [...new Set(candidates.map(c => c.credited_to))].sort(),
    [candidates]
  );

  const filteredCandidates = useMemo(() => {
    return candidates.filter((candidate) => {
      const matchesSearch = search === "" || 
        candidate.candidate_name.toLowerCase().includes(search.toLowerCase()) ||
        candidate.company_name.toLowerCase().includes(search.toLowerCase()) ||
        candidate.job_title.toLowerCase().includes(search.toLowerCase()) ||
        candidate.credited_to.toLowerCase().includes(search.toLowerCase());

      const matchesCompany = companyFilter.length === 0 || companyFilter.includes(candidate.company_name);
      const matchesStage = stageFilter.length === 0 || stageFilter.includes(candidate.pipeline_stage);
      const matchesStatus = statusFilter.length === 0 || statusFilter.includes(candidate.decision_status);
      const matchesSubmitter = submitterFilter.length === 0 || submitterFilter.includes(candidate.credited_to);

      return matchesSearch && matchesCompany && matchesStage && matchesStatus && matchesSubmitter;
    });
  }, [candidates, search, companyFilter, stageFilter, statusFilter, submitterFilter]);

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
                      Last imported: {new Date(lastUpdated).toLocaleDateString()} {new Date(lastUpdated).toLocaleTimeString()}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {sessionId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyLink}
                  className="gap-2"
                >
                  <Share2 className="h-4 w-4" />
                  Copy Share Link
                </Button>
              )}
              <AshbyFetchButton onUpload={handleCsvUpload} />
              <CsvUpload onUpload={handleCsvUpload} />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container py-6 space-y-6">
        {candidates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="p-4 bg-muted rounded-full mb-4">
              <Users className="h-8 w-8 text-muted-foreground" />
            </div>
            <h2 className="text-xl font-semibold text-foreground mb-2">No candidates yet</h2>
            <p className="text-muted-foreground mb-6 max-w-md">
              Upload a CSV file from your Ashby pipeline export to get started. 
              Once uploaded, you'll get a shareable link.
            </p>
            <CsvUpload onUpload={handleCsvUpload} />
          </div>
        ) : (
          <>
            {/* Stats */}
            <DashboardStats candidates={candidates} />

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
              </div>
            </div>

            {/* Results count */}
            <p className="text-sm text-muted-foreground">
              Showing {filteredCandidates.length} of {candidates.length} candidates
            </p>

            {/* Table */}
            <CandidateTable candidates={filteredCandidates} />
          </>
        )}
      </main>
    </div>
  );
};

export default Index;
