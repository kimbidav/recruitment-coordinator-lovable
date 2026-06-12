import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Check, Loader2, Plus } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useRecruiterAliases } from "@/hooks/useRecruiterAliases";
import { useAshbySnapshot } from "@/hooks/useAshbySnapshot";
import { normalizePersonName, suggestAliasesFromEmail } from "@/lib/recruiterIdentity";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * Onboarding step: "How does your name appear in Ashby?" — captures
 * agent_settings.recruiter_aliases by letting the user pick their own
 * credited_to values out of the org-shared snapshot (plus free text).
 */
export function RecruiterAliasStep({ onSaved }: { onSaved?: () => void }) {
  const { user } = useAuth();
  const { aliases, aliasesLoaded, saveAliases } = useRecruiterAliases();
  const { activeSnapshot, archivedSnapshot } = useAshbySnapshot();
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const [seeded, setSeeded] = useState(false);

  const creditedToValues = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of [...activeSnapshot, ...archivedSnapshot]) {
      const value = (c.credited_to ?? "").trim();
      const norm = normalizePersonName(value);
      if (value && norm && norm !== "unknown" && !seen.has(norm)) seen.set(norm, value);
    }
    return Array.from(seen.values()).sort();
  }, [activeSnapshot, archivedSnapshot]);

  // Seed the selection once: saved aliases win; otherwise guess from email.
  useEffect(() => {
    if (seeded || !aliasesLoaded) return;
    if (aliases.length > 0) {
      setSelected(aliases);
      setSeeded(true);
      return;
    }
    if (creditedToValues.length === 0) return;
    setSelected(suggestAliasesFromEmail(user?.email ?? "", creditedToValues));
    setSeeded(true);
  }, [seeded, aliasesLoaded, aliases, creditedToValues, user?.email]);

  const toggle = (value: string) => {
    setSelected((prev) =>
      prev.some((p) => normalizePersonName(p) === normalizePersonName(value))
        ? prev.filter((p) => normalizePersonName(p) !== normalizePersonName(value))
        : [...prev, value],
    );
  };

  const addCustom = () => {
    const value = custom.trim();
    if (!value) return;
    toggle(value);
    setCustom("");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const ok = await saveAliases(selected);
      if (ok) {
        toast.success("Saved — your pipeline now defaults to your own candidates.");
        onSaved?.();
      } else {
        toast.error("Could not save your Ashby identity. Try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  const isSelected = (value: string) =>
    selected.some((p) => normalizePersonName(p) === normalizePersonName(value));

  return (
    <div className="space-y-3">
      {creditedToValues.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {creditedToValues.map((value) => (
            <Badge
              key={value}
              variant={isSelected(value) ? "default" : "outline"}
              className={cn("cursor-pointer select-none", isSelected(value) && "gap-1")}
              onClick={() => toggle(value)}
            >
              {isSelected(value) && <Check className="h-3 w-3" />}
              {value}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Run an Ashby sync first and the names found in Ashby will appear here as suggestions —
          or type how your name appears in Ashby below.
        </p>
      )}
      {selected.filter((s) => !creditedToValues.some((v) => normalizePersonName(v) === normalizePersonName(s))).map((value) => (
        <Badge key={value} variant="default" className="cursor-pointer select-none gap-1 mr-1.5" onClick={() => toggle(value)}>
          <Check className="h-3 w-3" />
          {value}
        </Badge>
      ))}
      <div className="flex items-center gap-2">
        <Input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
          placeholder="Add another spelling (e.g. DK)"
          className="h-8 text-xs max-w-xs"
        />
        <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={addCustom}>
          <Plus className="h-3 w-3" />
          Add
        </Button>
        <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={handleSave} disabled={saving || selected.length === 0}>
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Save
        </Button>
      </div>
    </div>
  );
}
