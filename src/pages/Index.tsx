import { useState, useMemo } from "react";
import { candidatesData } from "@/data/candidates";
import { CandidateTable } from "@/components/CandidateTable";
import { DashboardStats } from "@/components/DashboardStats";
import { SearchInput } from "@/components/SearchInput";
import { FilterDropdown } from "@/components/FilterDropdown";
import { Users } from "lucide-react";

const Index = () => {
  const [search, setSearch] = useState("");
  const [companyFilter, setCompanyFilter] = useState("all");
  const [stageFilter, setStageFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const companies = useMemo(() => 
    [...new Set(candidatesData.map(c => c.company_name))].sort(),
    []
  );
  
  const stages = useMemo(() => 
    [...new Set(candidatesData.map(c => c.pipeline_stage))].sort(),
    []
  );
  
  const statuses = useMemo(() => 
    [...new Set(candidatesData.map(c => c.decision_status))].sort(),
    []
  );

  const filteredCandidates = useMemo(() => {
    return candidatesData.filter((candidate) => {
      const matchesSearch = search === "" || 
        candidate.candidate_name.toLowerCase().includes(search.toLowerCase()) ||
        candidate.company_name.toLowerCase().includes(search.toLowerCase()) ||
        candidate.job_title.toLowerCase().includes(search.toLowerCase()) ||
        candidate.credited_to.toLowerCase().includes(search.toLowerCase());

      const matchesCompany = companyFilter === "all" || candidate.company_name === companyFilter;
      const matchesStage = stageFilter === "all" || candidate.pipeline_stage === stageFilter;
      const matchesStatus = statusFilter === "all" || candidate.decision_status === statusFilter;

      return matchesSearch && matchesCompany && matchesStage && matchesStatus;
    });
  }, [search, companyFilter, stageFilter, statusFilter]);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary rounded-lg">
              <Users className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground">Candidate Pipeline</h1>
              <p className="text-sm text-muted-foreground">Track and manage your hiring pipeline</p>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container py-6 space-y-6">
        {/* Stats */}
        <DashboardStats candidates={candidatesData} />

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search candidates, companies, roles..."
            className="flex-1 max-w-md"
          />
          <div className="flex gap-3 flex-wrap">
            <FilterDropdown
              value={companyFilter}
              onChange={setCompanyFilter}
              options={companies}
              placeholder="Company"
              allLabel="All Companies"
              className="w-[160px]"
            />
            <FilterDropdown
              value={stageFilter}
              onChange={setStageFilter}
              options={stages}
              placeholder="Stage"
              allLabel="All Stages"
              className="w-[200px]"
            />
            <FilterDropdown
              value={statusFilter}
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
          Showing {filteredCandidates.length} of {candidatesData.length} candidates
        </p>

        {/* Table */}
        <CandidateTable candidates={filteredCandidates} />
      </main>
    </div>
  );
};

export default Index;
