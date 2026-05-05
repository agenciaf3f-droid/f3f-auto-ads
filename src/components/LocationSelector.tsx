import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MapPin, X, Search, Loader2, Plus, Minus } from "lucide-react";
import { searchLocations, type LocationResult } from "@/lib/meta-api";

export interface LocationItem {
  key: string;
  name: string;
  type: string;
  country_code: string;
  country_name: string;
  display: string;
}

interface LocationSelectorProps {
  accessToken: string;
  includedLocations: LocationItem[];
  excludedLocations: LocationItem[];
  onIncludedChange: (locations: LocationItem[]) => void;
  onExcludedChange: (locations: LocationItem[]) => void;
  presetId?: string;
}

type TabMode = "include" | "exclude";

// S/Nordeste preset: include Brasil, exclude Norte + Nordeste states
const NORTE_NORDESTE_EXCLUDE: LocationItem[] = [
  // NORTE
  { key: "319", name: "Acre", type: "region", country_code: "BR", country_name: "Brazil", display: "Acre, Brazil" },
  { key: "322", name: "Amapá", type: "region", country_code: "BR", country_name: "Brazil", display: "Amapá, Brazil" },
  { key: "321", name: "Amazonas", type: "region", country_code: "BR", country_name: "Brazil", display: "Amazonas, Brazil" },
  { key: "329", name: "Pará", type: "region", country_code: "BR", country_name: "Brazil", display: "Pará, Brazil" },
  { key: "331", name: "Rondônia", type: "region", country_code: "BR", country_name: "Brazil", display: "Rondônia, Brazil" },
  { key: "332", name: "Roraima", type: "region", country_code: "BR", country_name: "Brazil", display: "Roraima, Brazil" },
  { key: "337", name: "Tocantins", type: "region", country_code: "BR", country_name: "Brazil", display: "Tocantins, Brazil" },
  // NORDESTE
  { key: "320", name: "Alagoas", type: "region", country_code: "BR", country_name: "Brazil", display: "Alagoas, Brazil" },
  { key: "323", name: "Bahia", type: "region", country_code: "BR", country_name: "Brazil", display: "Bahia, Brazil" },
  { key: "325", name: "Ceará", type: "region", country_code: "BR", country_name: "Brazil", display: "Ceará, Brazil" },
  { key: "327", name: "Maranhão", type: "region", country_code: "BR", country_name: "Brazil", display: "Maranhão, Brazil" },
  { key: "330", name: "Paraíba", type: "region", country_code: "BR", country_name: "Brazil", display: "Paraíba, Brazil" },
  { key: "328", name: "Pernambuco", type: "region", country_code: "BR", country_name: "Brazil", display: "Pernambuco, Brazil" },
  { key: "333", name: "Piauí", type: "region", country_code: "BR", country_name: "Brazil", display: "Piauí, Brazil" },
  { key: "334", name: "Rio Grande do Norte", type: "region", country_code: "BR", country_name: "Brazil", display: "Rio Grande do Norte, Brazil" },
  { key: "336", name: "Sergipe", type: "region", country_code: "BR", country_name: "Brazil", display: "Sergipe, Brazil" },
];

const BRASIL_LOCATION: LocationItem = {
  key: "BR", name: "Brazil", type: "country", country_code: "BR", country_name: "Brazil", display: "Brasil",
};

export default function LocationSelector({
  accessToken,
  includedLocations,
  excludedLocations,
  onIncludedChange,
  onExcludedChange,
  presetId,
}: LocationSelectorProps) {
  const [activeTab, setActiveTab] = useState<TabMode>("include");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Debounced search
  useEffect(() => {
    if (!query || query.length < 2) { setResults([]); return; }
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await searchLocations(accessToken, query);
        setResults(r);
        setShowResults(true);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 400);
    return () => clearTimeout(timer);
  }, [query, accessToken]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showResults) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showResults]);

  const addLocation = (loc: LocationResult) => {
    const item: LocationItem = {
      key: loc.key, name: loc.name, type: loc.type,
      country_code: loc.country_code, country_name: loc.country_name,
      display: loc.display,
    };
    if (activeTab === "include") {
      if (!includedLocations.find(l => l.key === item.key)) {
        onIncludedChange([...includedLocations, item]);
      }
    } else {
      if (!excludedLocations.find(l => l.key === item.key)) {
        onExcludedChange([...excludedLocations, item]);
      }
    }
    setQuery("");
    setShowResults(false);
  };

  const removeIncluded = (key: string) => onIncludedChange(includedLocations.filter(l => l.key !== key));
  const removeExcluded = (key: string) => onExcludedChange(excludedLocations.filter(l => l.key !== key));

  const applyPresetBrasil = () => {
    onIncludedChange([BRASIL_LOCATION]);
    onExcludedChange([]);
  };

  const applyPresetSNordeste = () => {
    onIncludedChange([BRASIL_LOCATION]);
    onExcludedChange([...NORTE_NORDESTE_EXCLUDE]);
  };

  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader className="pb-3 pt-4 px-4">
        <div className="flex items-center gap-2">
          <MapPin className="w-4 h-4 text-primary" />
          <CardTitle className="text-sm font-semibold">Localizações</CardTitle>
        </div>
        <CardDescription className="text-[11px]">
          Escolha os lugares que deseja incluir ou excluir
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-4">
        {/* Presets */}
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">Presets rápidos</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs h-7 gap-1"
              onClick={applyPresetBrasil}
            >
              🇧🇷 Brasil
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs h-7 gap-1"
              onClick={applyPresetSNordeste}
            >
              🗺️ S/Nordeste
            </Button>
          </div>
        </div>

        <Separator className="opacity-30" />

        {/* Tabs */}
        <div className="flex rounded-md border border-border overflow-hidden">
          <button
            type="button"
            className={`flex-1 text-xs py-1.5 font-medium flex items-center justify-center gap-1 transition-colors ${
              activeTab === "include"
                ? "bg-primary text-primary-foreground"
                : "bg-muted/50 text-muted-foreground hover:bg-muted"
            }`}
            onClick={() => setActiveTab("include")}
          >
            <Plus className="w-3 h-3" /> Incluir
          </button>
          <button
            type="button"
            className={`flex-1 text-xs py-1.5 font-medium flex items-center justify-center gap-1 transition-colors ${
              activeTab === "exclude"
                ? "bg-destructive text-destructive-foreground"
                : "bg-muted/50 text-muted-foreground hover:bg-muted"
            }`}
            onClick={() => setActiveTab("exclude")}
          >
            <Minus className="w-3 h-3" /> Excluir
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder="Pesquisar país, estado, cidade..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => { if (results.length > 0) setShowResults(true); }}
              className="pl-8 h-8 text-xs"
            />
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />}
          </div>

          {showResults && results.length > 0 && (
            <div
              ref={dropdownRef}
              className="absolute z-50 w-full bg-popover border border-border rounded-md shadow-lg mt-1 max-h-48 overflow-y-auto"
            >
              {results.map((loc) => {
                const alreadyIncluded = includedLocations.find(l => l.key === loc.key);
                const alreadyExcluded = excludedLocations.find(l => l.key === loc.key);
                const alreadyAdded = activeTab === "include" ? alreadyIncluded : alreadyExcluded;
                return (
                  <button
                    key={loc.key}
                    type="button"
                    disabled={!!alreadyAdded}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-accent/50 transition-colors border-b border-border/20 last:border-0 disabled:opacity-40 disabled:cursor-not-allowed"
                    onClick={() => addLocation(loc)}
                  >
                    <span className="font-medium">{loc.name}</span>
                    {loc.type !== "country" && loc.country_name && (
                      <span className="text-muted-foreground"> — {loc.country_name}</span>
                    )}
                    <span className="text-[10px] text-muted-foreground ml-1.5">({loc.type})</span>
                    {alreadyAdded && <span className="text-[10px] text-primary ml-1">✓ já adicionado</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Included chips */}
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground flex items-center gap-1">
            <Plus className="w-3 h-3" /> Incluir ({includedLocations.length})
          </Label>
          {includedLocations.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {includedLocations.map((loc) => (
                <Badge key={loc.key} variant="secondary" className="text-[11px] gap-1 pr-1 bg-primary/10 text-primary border-primary/20">
                  {loc.display || loc.name}
                  <button
                    type="button"
                    onClick={() => removeIncluded(loc.key)}
                    className="hover:bg-primary/20 rounded-full p-0.5 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground italic">Nenhuma localização incluída</p>
          )}
        </div>

        {/* Excluded chips */}
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground flex items-center gap-1">
            <Minus className="w-3 h-3" /> Excluir ({excludedLocations.length})
          </Label>
          {excludedLocations.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {excludedLocations.map((loc) => (
                <Badge key={loc.key} variant="secondary" className="text-[11px] gap-1 pr-1 bg-destructive/10 text-destructive border-destructive/20">
                  {loc.display || loc.name}
                  <button
                    type="button"
                    onClick={() => removeExcluded(loc.key)}
                    className="hover:bg-destructive/20 rounded-full p-0.5 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground italic">Nenhuma exclusão</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
