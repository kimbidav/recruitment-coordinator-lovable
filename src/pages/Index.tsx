import { useState, useMemo } from "react";
import { candidatesData, Candidate } from "@/data/candidates";
import { CandidateTable } from "@/components/CandidateTable";
import { DashboardStats } from "@/components/DashboardStats";
import { SearchInput } from "@/components/SearchInput";
import { MultiSelectDropdown } from "@/components/MultiSelectDropdown";
import { CsvUpload } from "@/components/CsvUpload";
import { Users } from "lucide-react";
const Index = () => {
  const [candidates, setCandidates] = useState<Candidate[]>(candidatesData);
  const [search, setSearch] = useState("");
  const [companyFilter, setCompanyFilter] = useState<string[]>([]);
  const [stageFilter, setStageFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [submitterFilter, setSubmitterFilter] = useState<string[]>([]);
  const handleCsvUpload = (uploadedCandidates: Candidate[]) => {
    setCandidates(uploadedCandidates);
    // Reset filters when new data is loaded
    setCompanyFilter([]);
    setStageFilter([]);
    setStatusFilter([]);
    setSubmitterFilter([]);
    setSearch("");
  };
  const companies = useMemo(() => [...new Set(candidates.map(c => c.company_name))].sort(), [candidates]);
  const stages = useMemo(() => [...new Set(candidates.map(c => c.pipeline_stage))].sort(), [candidates]);
  const statuses = useMemo(() => [...new Set(candidates.map(c => c.decision_status))].sort(), [candidates]);
  const submitters = useMemo(() => [...new Set(candidates.map(c => c.credited_to))].sort(), [candidates]);
  const filteredCandidates = useMemo(() => {
    return candidates.filter(candidate => {
      const matchesSearch = search === "" || candidate.candidate_name.toLowerCase().includes(search.toLowerCase()) || candidate.company_name.toLowerCase().includes(search.toLowerCase()) || candidate.job_title.toLowerCase().includes(search.toLowerCase()) || candidate.credited_to.toLowerCase().includes(search.toLowerCase());
      const matchesCompany = companyFilter.length === 0 || companyFilter.includes(candidate.company_name);
      const matchesStage = stageFilter.length === 0 || stageFilter.includes(candidate.pipeline_stage);
      const matchesStatus = statusFilter.length === 0 || statusFilter.includes(candidate.decision_status);
      const matchesSubmitter = submitterFilter.length === 0 || submitterFilter.includes(candidate.credited_to);
      return matchesSearch && matchesCompany && matchesStage && matchesStatus && matchesSubmitter;
    });
  }, [candidates, search, companyFilter, stageFilter, statusFilter, submitterFilter]);
  return <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container py-4">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary rounded-lg">
                <Users className="h-5 w-5 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-foreground">Ashby Pipeline Overview</h1>
                <p className="text-sm text-muted-foreground">Track and manage your hiring pipeline</p>
              </div>
            </div>
            <CsvUpload onUpload={handleCsvUpload} />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container py-6 space-y-6">
        {/* Stats */}
        <DashboardStats candidates={candidates} />

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search candidates, companies, roles..." className="flex-1 max-w-md" />
          <div className="flex gap-3 flex-wrap">
            <MultiSelectDropdown values={companyFilter} onChange={setCompanyFilter} options={companies} placeholder="Company" allLabel="All Companies" className="w-[160px]" />
            <MultiSelectDropdown values={submitterFilter} onChange={setSubmitterFilter} options={submitters} placeholder="Submitted By" allLabel="All Submitters" className="w-[160px]" />
            <MultiSelectDropdown values={stageFilter} onChange={setStageFilter} options={stages} placeholder="Stage" allLabel="All Stages" className="w-[200px]" />
            <MultiSelectDropdown values={statusFilter} onChange={setStatusFilter} options={statuses} placeholder="Status" allLabel="All Statuses" className="w-[180px]" />
          </div>
        </div>

        {/* Results count */}
        <p className="text-sm text-muted-foreground">
          Showing {filteredCandidates.length} of {candidates.length} candidates
        </p>

        {/* Table */}
        <CandidateTable candidates={filteredCandidates} />
      </main>
    </div>;
};
export default Index;