import { Users, Clock, CheckCircle, AlertCircle } from "lucide-react";
import { Candidate } from "@/data/candidates";

interface DashboardStatsProps {
  candidates: Candidate[];
}

export function DashboardStats({ candidates }: DashboardStatsProps) {
  const totalCandidates = candidates.length;
  const inOffer = candidates.filter(c => c.pipeline_stage.toLowerCase().includes("offer")).length;
  const needsAttention = candidates.filter(c => 
    c.decision_status.toLowerCase().includes("needs") || 
    c.decision_status.toLowerCase().includes("waiting")
  ).length;
  const avgDaysInStage = Math.round(
    candidates.reduce((acc, c) => acc + c.days_in_stage, 0) / candidates.length
  );

  const stats = [
    {
      label: "Total Candidates",
      value: totalCandidates,
      icon: Users,
      iconColor: "text-status-active",
      iconBg: "bg-status-active-bg",
    },
    {
      label: "In Offer Stage",
      value: inOffer,
      icon: CheckCircle,
      iconColor: "text-status-offer",
      iconBg: "bg-status-offer-bg",
    },
    {
      label: "Needs Attention",
      value: needsAttention,
      icon: AlertCircle,
      iconColor: "text-status-warning",
      iconBg: "bg-status-warning-bg",
    },
    {
      label: "Avg. Days in Stage",
      value: avgDaysInStage,
      icon: Clock,
      iconColor: "text-muted-foreground",
      iconBg: "bg-secondary",
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="bg-card rounded-lg border border-border p-5 shadow-card"
        >
          <div className="flex items-center gap-4">
            <div className={`p-2.5 rounded-lg ${stat.iconBg}`}>
              <stat.icon className={`h-5 w-5 ${stat.iconColor}`} />
            </div>
            <div>
              <p className="text-2xl font-semibold text-foreground">{stat.value}</p>
              <p className="text-sm text-muted-foreground">{stat.label}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
