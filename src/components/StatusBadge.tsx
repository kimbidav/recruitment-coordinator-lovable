import { cn } from "@/lib/utils";

type StatusType = "offer" | "active" | "warning" | "backburner" | "hired" | "archived";

interface StatusBadgeProps {
  status: string;
  /** Ashby archiveReason (e.g. "Did Not Respond to Outreach") — tooltip. */
  reason?: string | null;
  className?: string;
}

function getStatusType(status: string): StatusType {
  const lowerStatus = status.toLowerCase();

  if (lowerStatus.includes("hired")) {
    return "hired";
  }
  if (["archived", "rejected", "closed", "withdrawn"].some((k) => lowerStatus.includes(k))) {
    return "archived";
  }
  if (lowerStatus.includes("offer") || lowerStatus.includes("acceptance")) {
    return "offer";
  }
  if (lowerStatus.includes("needs") || lowerStatus.includes("waiting") || lowerStatus.includes("decision")) {
    return "warning";
  }
  if (lowerStatus.includes("back burner") || lowerStatus.includes("backburner")) {
    return "backburner";
  }
  return "active";
}

const statusStyles: Record<StatusType, string> = {
  offer: "bg-status-offer-bg text-status-offer",
  active: "bg-status-active-bg text-status-active",
  warning: "bg-status-warning-bg text-status-warning",
  backburner: "bg-status-backburner-bg text-status-backburner",
  hired: "bg-emerald-100 text-emerald-700",
  archived: "bg-muted text-muted-foreground",
};

export function StatusBadge({ status, reason, className }: StatusBadgeProps) {
  const statusType = getStatusType(status);

  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap",
        statusStyles[statusType],
        className
      )}
      title={reason ?? undefined}
    >
      {statusType === "hired" ? "🎉 " : ""}
      {status}
    </span>
  );
}
