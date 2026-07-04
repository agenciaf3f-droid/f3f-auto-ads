import { useState } from "react";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DATE_PRESETS, type DateRangeSelection } from "@/lib/meta-insights";

const toISODate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const CUSTOM = "__custom__";

export default function DateRangeSelector({
  value,
  onChange,
}: {
  value: DateRangeSelection;
  onChange: (v: DateRangeSelection) => void;
}) {
  const [since, setSince] = useState<Date | undefined>();
  const [until, setUntil] = useState<Date | undefined>();

  const selectValue = value.mode === "custom" ? CUSTOM : value.preset;

  const handleSelect = (v: string) => {
    if (v === CUSTOM) {
      if (since && until) onChange({ mode: "custom", since: toISODate(since), until: toISODate(until) });
      else onChange({ mode: "custom", since: "", until: "" });
    } else {
      onChange({ mode: "preset", preset: v });
    }
  };

  const emitCustom = (s?: Date, u?: Date) => {
    if (s && u) onChange({ mode: "custom", since: toISODate(s), until: toISODate(u) });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={selectValue} onValueChange={handleSelect}>
        <SelectTrigger className="w-[180px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DATE_PRESETS.map((p) => (
            <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
          ))}
          <SelectItem value={CUSTOM}>Personalizado</SelectItem>
        </SelectContent>
      </Select>

      {value.mode === "custom" && (
        <div className="flex items-center gap-2">
          <DatePicker
            label="Início"
            date={since}
            onSelect={(d) => { setSince(d); emitCustom(d, until); }}
          />
          <span className="text-muted-foreground text-sm">até</span>
          <DatePicker
            label="Fim"
            date={until}
            onSelect={(d) => { setUntil(d); emitCustom(since, d); }}
          />
        </div>
      )}
    </div>
  );
}

function DatePicker({ label, date, onSelect }: { label: string; date?: Date; onSelect: (d?: Date) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="justify-start font-normal">
          <CalendarIcon className="mr-2 h-3.5 w-3.5" />
          {date ? date.toLocaleDateString("pt-BR") : label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar mode="single" selected={date} onSelect={onSelect} initialFocus />
      </PopoverContent>
    </Popover>
  );
}
