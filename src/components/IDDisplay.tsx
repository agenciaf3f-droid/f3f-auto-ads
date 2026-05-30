import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface IDDisplayProps {
  id: string;
  label?: string;
}

export default function IDDisplay({ id, label }: IDDisplayProps) {
  const handleCopy = () => {
    navigator.clipboard.writeText(id);
    toast.success(`${label || "ID"} copiado!`);
  };

  return (
    <div className="bg-muted/30 rounded px-2 py-1 max-w-sm flex items-center gap-2">
      {label && <span className="text-xs font-medium text-muted-foreground shrink-0">{label}:</span>}
      <span className="text-xs font-mono text-foreground truncate flex-1">{id}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 shrink-0"
        onClick={handleCopy}
        aria-label={`Copiar ${label || "ID"}`}
      >
        <Copy className="w-3 h-3" />
      </Button>
    </div>
  );
}
