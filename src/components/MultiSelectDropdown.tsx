import { useState, useRef, useEffect } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface MultiSelectDropdownProps {
  values: string[];
  onChange: (values: string[]) => void;
  options: string[];
  placeholder: string;
  className?: string;
  allLabel?: string;
}

export function MultiSelectDropdown({
  values,
  onChange,
  options,
  placeholder,
  className,
  allLabel = "All",
}: MultiSelectDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const toggleOption = (option: string) => {
    if (values.includes(option)) {
      onChange(values.filter((v) => v !== option));
    } else {
      onChange([...values, option]);
    }
  };

  const clearAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange([]);
  };

  const displayText = values.length === 0 
    ? allLabel 
    : values.length === 1 
      ? values[0] 
      : `${values.length} selected`;

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <Button
        variant="outline"
        role="combobox"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className="w-full justify-between bg-card border-border font-normal"
      >
        <span className="truncate">{displayText}</span>
        <div className="flex items-center gap-1 ml-2">
          {values.length > 0 && (
            <span
              onClick={clearAll}
              className="h-4 w-4 rounded-full bg-muted hover:bg-muted-foreground/20 flex items-center justify-center"
            >
              <X className="h-3 w-3" />
            </span>
          )}
          <ChevronDown className={cn("h-4 w-4 shrink-0 opacity-50 transition-transform", isOpen && "rotate-180")} />
        </div>
      </Button>
      
      {isOpen && (
        <div className="absolute z-50 mt-1 w-full min-w-[200px] rounded-md border border-border bg-popover shadow-lg">
          <div className="max-h-[300px] overflow-auto p-1">
            <div
              onClick={() => onChange([])}
              className={cn(
                "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground",
                values.length === 0 && "bg-accent"
              )}
            >
              <Check className={cn("mr-2 h-4 w-4", values.length === 0 ? "opacity-100" : "opacity-0")} />
              {allLabel}
            </div>
            
            <div className="my-1 h-px bg-border" />
            
            {options.map((option) => (
              <div
                key={option}
                onClick={() => toggleOption(option)}
                className={cn(
                  "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground",
                  values.includes(option) && "bg-accent/50"
                )}
              >
                <Check className={cn("mr-2 h-4 w-4", values.includes(option) ? "opacity-100" : "opacity-0")} />
                {option}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
