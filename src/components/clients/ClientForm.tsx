import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { fetchAdAccounts } from "@/lib/meta-api";
import {
  createClient,
  updateClient,
  linkAdAccount,
  unlinkAdAccount,
  listClientAdAccounts,
  type Client,
} from "@/lib/clients";

interface AdAccount {
  id: string;
  name: string;
  currency?: string | null;
  account_status?: number | null;
}

// account_status: 1=ativo; qualquer outro = alguma restrição (2=desabilitada, etc.)
const statusLabel = (s?: number | null) => (s === 1 ? null : "inativa");

export default function ClientForm({
  open,
  onClose,
  onSaved,
  accessToken,
  client,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  accessToken?: string;
  client?: Client | null;
}) {
  const isEdit = !!client;
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [accounts, setAccounts] = useState<AdAccount[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(client?.name || "");
    setNotes(client?.notes || "");
    setSelected(new Set());
    if (isEdit && client) {
      listClientAdAccounts(client.id)
        .then((links) => setSelected(new Set(links.map((l) => l.ad_account_id))))
        .catch(() => {});
    }
  }, [open, client, isEdit]);

  useEffect(() => {
    if (!open || !accessToken) return;
    setLoadingAccounts(true);
    fetchAdAccounts(accessToken)
      .then((accs: AdAccount[]) => setAccounts(accs))
      .catch(() => toast.error("Erro ao carregar contas de anúncio"))
      .finally(() => setLoadingAccounts(false));
  }, [open, accessToken]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("Nome do cliente é obrigatório");
      return;
    }
    setSaving(true);
    try {
      const nameById = new Map(accounts.map((a) => [a.id, a.name]));
      if (isEdit && client) {
        await updateClient(client.id, { name: name.trim(), notes: notes.trim() || null });
        const existing = await listClientAdAccounts(client.id);
        const existingIds = new Set(existing.map((l) => l.ad_account_id));
        // linka novos
        for (const id of selected) {
          if (!existingIds.has(id)) await linkAdAccount(client.id, id, nameById.get(id) || null);
        }
        // desvincula removidos
        for (const link of existing) {
          if (!selected.has(link.ad_account_id)) await unlinkAdAccount(link.id);
        }
        toast.success("Cliente atualizado");
      } else {
        const created = await createClient(name.trim(), notes.trim() || undefined);
        for (const id of selected) {
          await linkAdAccount(created.id, id, nameById.get(id) || null);
        }
        toast.success("Cliente criado");
      }
      onSaved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message || "Erro ao salvar cliente");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Editar cliente" : "Novo cliente"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="client-name">Nome</Label>
            <Input id="client-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Loja do João" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="client-notes">Notas (opcional)</Label>
            <Input id="client-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Observações internas" />
          </div>

          <div className="space-y-1.5">
            <Label>Contas de anúncio</Label>
            {!accessToken ? (
              <p className="text-sm text-muted-foreground">Conecte a conta Meta em Configurações para vincular contas.</p>
            ) : loadingAccounts ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando contas…
              </div>
            ) : accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma conta encontrada.</p>
            ) : (
              <div className="h-48 overflow-y-auto rounded-md border p-2">
                <div className="space-y-1">
                  {accounts.map((acc) => {
                    const badge = statusLabel(acc.account_status);
                    return (
                      <label key={acc.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent-soft transition-colors cursor-pointer">
                        <Checkbox className="shrink-0" checked={selected.has(acc.id)} onCheckedChange={() => toggle(acc.id)} />
                        <span className="text-sm flex-1 min-w-0 truncate">{acc.name}</span>
                        {acc.currency && <Badge variant="outline" className="text-[10px] shrink-0">{acc.currency}</Badge>}
                        {badge && <Badge variant="destructive" className="text-[10px] shrink-0">{badge}</Badge>}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {isEdit ? "Salvar" : "Criar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
