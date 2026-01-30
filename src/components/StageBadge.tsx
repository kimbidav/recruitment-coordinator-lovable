import { cn } from "@/lib/utils";

type StageType = "offer" | "interview" | "backburner" | "default";

interface StageBadgeProps {
  stage: string;
  className?: string;
}

function getStageType(stage: string): StageType {
  const lowerStage = stage.toLowerCase();
  
  if (lowerStage.includes("offer")) {
    return "offer";
  }
  if (lowerStage.includes("back burner") || lowerStage.includes("backburner")) {
    return "backburner";
  }
  if (lowerStage.includes("interview") || lowerStage.includes("call") || lowerStage.includes("round")) {
    return "interview";
  }
  return "default";
}

const stageStyles: Record<StageType, string> = {
  offer: "bg-status-offer-bg text-status-offer border-status-offer/20",
  interview: "bg-status-active-bg text-status-active border-status-active/20",
  backburner: "bg-status-backburner-bg text-status-backburner border-status-backburner/20",
  default: "bg-secondary text-secondary-foreground border-border",
};

export function StageBadge({ stage, className }: StageBadgeProps) {
  const stageType = getStageType(stage);
  
  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium border whitespace-nowrap",
        stageStyles[stageType],
        className
      )}
    >
      {stage}
    </span>
  );
}
