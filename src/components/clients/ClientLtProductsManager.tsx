import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { addClientLtProduct, deleteClientLtProduct, type ClientLtProduct } from "@/lib/clients";

const MAX_PRODUCTS = 10;

// Produtos Low-Ticket do cliente. L.T é identificada pela nomenclatura [PRODUTO] no nome da campanha
// (ex: [DDX]); esta lista é o vocabulário que alimenta o dropdown de produto nas regras de KPI L.T.
export default function ClientLtProductsManager({
  clientId,
  products,
  onChanged,
}: {
  clientId: string;
  products: ClientLtProduct[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Informe o nome do produto (ex: DDX)");
      return;
    }
    setSaving(true);
    try {
      await addClientLtProduct(clientId, trimmed);
      setName("");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message || "Erro ao adicionar produto");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteClientLtProduct(id);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message || "Erro ao remover produto");
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Produtos Low-Ticket deste cliente. Usados para reconhecer as campanhas L.T pela nomenclatura{" "}
        <span className="font-mono">[PRODUTO]</span> e configurar KPIs por produto. FASE 1/2/3 não precisam disso.
      </p>

      {products.length === 0 && (
        <p className="text-sm text-muted-foreground">Nenhum produto ainda. Adicione o primeiro (ex: DDX).</p>
      )}

      {products.map((p) => (
        <div key={p.id} className="flex items-center gap-2 text-sm rounded-md border border-border/60 bg-muted/20 px-3 py-2">
          <span className="flex-1 min-w-0 truncate font-medium">{p.product_name}</span>
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => remove(p.id)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}

      {products.length >= MAX_PRODUCTS ? (
        <p className="text-[10px] text-muted-foreground">Limite de {MAX_PRODUCTS} produtos por cliente atingido.</p>
      ) : (
        <div className="flex items-end gap-2 pt-1">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            placeholder="ex: DDX"
            className="h-8 flex-1"
          />
          <Button size="sm" onClick={add} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            <span className="ml-1">Adicionar</span>
          </Button>
        </div>
      )}

      {products.length > 0 && (
        <p className="text-[10px] text-muted-foreground">
          Remover um produto não apaga regras de KPI já criadas com esse nome — elas continuam ativas.
        </p>
      )}
    </div>
  );
}
