import { Building2, Pencil, Trash2, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Client } from "@/lib/clients";

export default function ClientCard({
  client,
  accountCount,
  onManage,
  onEdit,
  onDelete,
}: {
  client: Client;
  accountCount: number;
  onManage: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-lg border p-4 flex items-center gap-3 hover:border-primary/30 transition-colors">
      <div className="w-9 h-9 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
        <Building2 className="w-4 h-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-display font-semibold text-sm truncate">{client.name}</h3>
          <Badge variant="outline" className="text-[10px] shrink-0">
            {accountCount} {accountCount === 1 ? "conta" : "contas"}
          </Badge>
        </div>
        {client.notes && <p className="text-xs text-muted-foreground truncate">{client.notes}</p>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button variant="ghost" size="sm" onClick={onManage} className="gap-1.5">
          <BarChart3 className="h-3.5 w-3.5" /> KPIs
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
