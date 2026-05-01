import { useRef } from "react";
import { Upload, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import Papa from "papaparse";
import { Candidate } from "@/data/candidates";
import { toast } from "sonner";

interface CsvUploadProps {
  onUpload: (candidates: Candidate[]) => void;
}

interface CsvRow {
  company_name: string;
  job_title: string;
  job_id: string;
  candidate_name: string;
  candidate_id: string;
  pipeline_stage: string;
  decision_status: string;
  stage_type: string;
  current_stage_index: string;
  total_stages: string;
  stage_progress: string;
  last_activity_at: string;
  days_in_stage: string;
  needs_scheduling: string;
  credited_to: string;
  source: string;
  feedback_count: string;
  latest_recommendation?: string;
  latest_feedback_author?: string;
  latest_feedback_date?: string;
  current_stage_interviews?: string;
  current_stage_avg_score?: string;
  current_stage_date?: string;
  interview_history_summary?: string;
}

function parseCsvRow(row: CsvRow): Candidate {
  return {
    company_name: row.company_name || "",
    job_title: row.job_title || "",
    job_id: row.job_id || "",
    candidate_name: row.candidate_name || "",
    candidate_id: row.candidate_id || "",
    pipeline_stage: row.pipeline_stage || "",
    decision_status: row.decision_status || "",
    stage_type: row.stage_type || "",
    current_stage_index: parseInt(row.current_stage_index, 10) || 0,
    total_stages: parseInt(row.total_stages, 10) || 0,
    stage_progress: row.stage_progress || "",
    last_activity_at: row.last_activity_at || "",
    days_in_stage: parseInt(row.days_in_stage, 10) || 0,
    needs_scheduling: row.needs_scheduling?.toLowerCase() === "true",
    credited_to: row.credited_to || "",
    source: row.source || "",
    feedback_count: parseInt(row.feedback_count, 10) || 0,
    latest_recommendation: row.latest_recommendation || undefined,
    latest_feedback_author: row.latest_feedback_author || undefined,
    latest_feedback_date: row.latest_feedback_date || undefined,
    current_stage_interviews: row.current_stage_interviews || undefined,
    current_stage_avg_score: row.current_stage_avg_score ? parseFloat(row.current_stage_avg_score) : undefined,
    current_stage_date: row.current_stage_date || undefined,
    interview_history_summary: row.interview_history_summary || undefined,
  };
}

export function CsvUpload({ onUpload }: CsvUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith(".csv")) {
      toast.error("Please upload a CSV file");
      return;
    }

    Papa.parse<CsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (results.errors.length > 0) {
          console.error("CSV parsing errors:", results.errors);
          toast.error("Error parsing CSV file");
          return;
        }

        const candidates = results.data.map(parseCsvRow);
        onUpload(candidates);
        toast.success(`Loaded ${candidates.length} candidates from CSV`);
        
        // Reset the input
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      },
      error: (error) => {
        console.error("CSV parsing error:", error);
        toast.error("Failed to parse CSV file");
      },
    });
  };

  return (
    <div className="flex items-center gap-2">
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        onChange={handleFileChange}
        className="hidden"
        id="csv-upload"
      />
      <Button
        variant="outline"
        onClick={() => fileInputRef.current?.click()}
        className="gap-2"
      >
        <Upload className="h-4 w-4" />
        Upload CSV
      </Button>
      <div className="text-xs text-muted-foreground flex items-center gap-1">
        <FileSpreadsheet className="h-3.5 w-3.5" />
        <span>Ashby pipeline export</span>
      </div>
    </div>
  );
}
