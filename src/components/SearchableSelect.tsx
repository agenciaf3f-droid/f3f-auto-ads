import { useState, useMemo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, Check, ChevronDown } from "lucide-react";

interface Option {
  id: string;
  name: string;
}

interface SearchableSelectProps {
  options: Option[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
}

export default function SearchableSelect({
  options,
  value,
  onValueChange,
  placeholder = "Selecione...",
  searchPlaceholder = "Pesquisar...",
}: SearchableSelectProps) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const filtered = useMemo(() => {
    if (!search) return options;
    const q = search.toLowerCase();
    return options.filter(
      (o) => o.name.toLowerCase().includes(q) || o.id.toLowerCase().includes(q)
    );
  }, [options, search]);

  const selectedName = options.find((o) => o.id === value)?.name;

  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on resize. Reposition on scroll EXTERNO; ignora scroll dentro do dropdown.
  useEffect(() => {
    if (!open) return;
    const close = () => { setOpen(false); setSearch(""); };
    const onScroll = (e: Event) => {
      const target = e.target as Node;
      if (dropdownRef.current && target && dropdownRef.current.contains(target)) return;
      // Scroll externo: reposiciona em vez de fechar
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        setDropdownStyle({
          position: "fixed",
          top: rect.bottom + 4,
          left: rect.left,
          width: rect.width,
          zIndex: 9999,
        });
      }
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  // Close on ESC
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setSearch(""); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setDropdownStyle({
        position: "fixed",
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        zIndex: 9999,
      });
    }
  }, [open]);

  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input without scrolling after portal renders
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus({ preventScroll: true });
    }
  }, [open]);

  const dropdown = open ? createPortal(
    <>
      <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={() => { setOpen(false); setSearch(""); }} />
      <div
        ref={dropdownRef}
        style={dropdownStyle}
        className="rounded-md border border-border bg-popover shadow-xl"
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 pl-7 text-xs"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
        <div
          className="overflow-y-auto overscroll-contain"
          style={{ maxHeight: 240 }}
          onWheel={(e) => e.stopPropagation()}
        >
          {filtered.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground text-center">Nenhum resultado</p>
          ) : (
            filtered.map((o) => (
              <div
                key={o.id}
                className={`flex items-center justify-between px-3 py-2 text-xs cursor-pointer hover:bg-accent/10 transition-colors ${
                  o.id === value ? "bg-primary/10 text-primary" : ""
                }`}
                onClick={() => {
                  onValueChange(o.id);
                  setOpen(false);
                  setSearch("");
                }}
              >
                <div className="min-w-0">
                  <span className="font-medium">{o.name}</span>
                  {o.id !== o.name && (
                    <span className="ml-2 text-muted-foreground text-[10px]">{o.id}</span>
                  )}
                </div>
                {o.id === value && <Check className="w-3.5 h-3.5 shrink-0" />}
              </div>
            ))
          )}
        </div>
      </div>
    </>,
    document.body
  ) : null;

  return (
    <>
      <div
        ref={triggerRef}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm cursor-pointer items-center justify-between hover:border-primary/50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <span className={selectedName ? "text-foreground truncate" : "text-muted-foreground"}>
          {selectedName || placeholder}
        </span>
        <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
      </div>
      {dropdown}
    </>
  );
}
