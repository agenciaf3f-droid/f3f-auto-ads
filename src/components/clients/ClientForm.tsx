import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fetchAdAccounts } from "@/lib/meta-api";
import {
  createClient,
  updateClient,
  deleteClient,
  linkAdAccount,
  unlinkAdAccount,
  listClientAdAccounts,
  listClientDashboards,
  syncWhatsappGroups,
  type Client,
  type ClientAdAccount,
} from "@/lib/clients";

interface AdAccount {
  id: string;
  name: string;
  currency?: string | null;
  account_status?: number | null;
}

interface ClientDashboard {
  nome: string;
  email: string | null;
  whatsapp_group_id: string;
}

// Normaliza texto p/ comparação de nomes (remove acento, colapsa espaços, minúsculo).
function normalizeForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// "F3F - <Nome> - <PLANO>" → "<nome>" normalizado (tira prefixo "F3F -" e sufixo " - <PLANO>").
function dashboardCoreName(nome: string): string {
  const semPrefixo = nome.replace(/^\s*f3f\s*-\s*/i, "");
  const semSufixo = semPrefixo.replace(/\s*-\s*[^-]*$/, "");
  return normalizeForMatch(semSufixo);
}

export default function ClientForm({
  open,
  onClose,
  onSaved,
  accessToken,
  client,
  clients,
  linksByClient,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  accessToken?: string;
  client?: Client | null;
  clients: Client[];
  linksByClient: Record<string, ClientAdAccount[]>;
}) {
  const isEdit = !!client;
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [accounts, setAccounts] = useState<AdAccount[]>([]);
  const [accountSearch, setAccountSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dashboards, setDashboards] = useState<ClientDashboard[]>([]);
  const [groupId, setGroupId] = useState("");
  const [groupTouched, setGroupTouched] = useState(false);
  const [groupSearch, setGroupSearch] = useState("");
  const [syncingGroups, setSyncingGroups] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(client?.name || "");
    setNotes(client?.notes || "");
    setAccountSearch("");
    setSelected(new Set());
    // Edição: pré-preenche com o grupo já salvo. Criação: vazio (o auto-match preenche depois).
    setGroupId(client?.whatsapp_group_id || "");
    setGroupTouched(false);
    setGroupSearch("");
    if (isEdit && client) {
      listClientAdAccounts(client.id)
        .then((links) => setSelected(new Set(links.map((l) => l.ad_account_id))))
        .catch(() => {});
    }
  }, [open, client, isEdit]);

  // Grupos conhecidos (tabela local, sincronizada de Agenciaf3f) — pro dropdown de grupo, na
  // criação E na edição.
  useEffect(() => {
    if (!open) return;
    listClientDashboards()
      .then((rows) => setDashboards(rows))
      .catch(() => setDashboards([])); // sem integração configurada ainda → cai no fallback manual
  }, [open]);

  // Re-sincroniza da base Agenciaf3f sob demanda (botão) — não roda sozinho, é pesado (~99k
  // linhas do log de mensagens do lado de lá).
  async function handleSyncGroups() {
    setSyncingGroups(true);
    try {
      const res = await syncWhatsappGroups();
      toast.success(`Grupos sincronizados: ${res.synced} (${res.from_dashboards} do dashboard, ${res.from_log} do log).`);
      const rows = await listClientDashboards();
      setDashboards(rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao sincronizar grupos");
    } finally {
      setSyncingGroups(false);
    }
  }

  // Auto-casa o grupo pelo nome normalizado enquanto o gestor não mexer manualmente no campo.
  useEffect(() => {
    if (!open || isEdit || groupTouched || dashboards.length === 0) return;
    const typed = normalizeForMatch(name);
    if (!typed) return;
    const match = dashboards.find((d) => dashboardCoreName(d.nome) === typed);
    setGroupId(match?.whatsapp_group_id || "");
  }, [name, dashboards, open, isEdit, groupTouched]);

  useEffect(() => {
    if (!open || !accessToken) return;
    setLoadingAccounts(true);
    fetchAdAccounts(accessToken)
      .then((accs: AdAccount[]) => setAccounts(accs))
      .catch(() => toast.error("Erro ao carregar contas de anúncio"))
      .finally(() => setLoadingAccounts(false));
  }, [open, accessToken]);

  // Contas já vinculadas a OUTROS clientes do gestor (UNIQUE(user_id, ad_account_id) no banco —
  // uma conta só pode pertencer a 1 cliente). Exclui os links do próprio cliente em edição.
  const accountOwner = useMemo(() => {
    const map = new Map<string, { clientId: string; clientName: string }>();
    for (const [clientId, links] of Object.entries(linksByClient)) {
      if (isEdit && client && clientId === client.id) continue;
      const owner = clients.find((c) => c.id === clientId);
      for (const link of links) {
        map.set(link.ad_account_id, { clientId, clientName: owner?.name || "outro cliente" });
      }
    }
    return map;
  }, [linksByClient, clients, isEdit, client]);

  const filteredDashboards = useMemo(() => {
    const q = groupSearch.trim().toLowerCase();
    if (!q) return dashboards;
    return dashboards.filter(
      (d) => d.nome.toLowerCase().includes(q) || d.whatsapp_group_id.toLowerCase().includes(q),
    );
  }, [dashboards, groupSearch]);
  const matchedDashboard = dashboards.find((d) => d.whatsapp_group_id === groupId);

  const toggle = (id: string) => {
    if (accountOwner.has(id)) return;
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
    const conflicts = [...selected].filter((id) => accountOwner.has(id));
    if (conflicts.length > 0) {
      const names = conflicts.map((id) => accounts.find((a) => a.id === id)?.name || id).join(", ");
      toast.error(`Remova as contas já vinculadas a outro cliente antes de salvar: ${names}`);
      return;
    }
    setSaving(true);
    try {
      const nameById = new Map(accounts.map((a) => [a.id, a.name]));
      if (isEdit && client) {
        await updateClient(client.id, { name: name.trim(), notes: notes.trim() || null, whatsapp_group_id: groupId || null });
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
        // Cria o cliente só depois de validar os conflitos acima. Se mesmo assim o link falhar
        // (corrida entre abas), desfaz o cliente recém-criado para não sobrar linha órfã que
        // duplicaria num retry.
        const created = await createClient(name.trim(), notes.trim() || undefined, groupId || undefined);
        try {
          for (const id of selected) {
            await linkAdAccount(created.id, id, nameById.get(id) || null);
          }
        } catch (linkErr) {
          await deleteClient(created.id).catch(() => {});
          throw linkErr;
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

  const q = accountSearch.trim().toLowerCase();
  const filteredAccounts = q
    ? accounts.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
    : accounts;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Editar cliente" : "Novo cliente"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 min-w-0">
          <div className="space-y-1.5">
            <Label htmlFor="client-name">Nome</Label>
            <Input id="client-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Loja do João" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="client-notes">Notas (opcional)</Label>
            <Input id="client-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Observações internas" />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label>Grupo do WhatsApp (cliente)</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-muted-foreground"
                onClick={handleSyncGroups}
                disabled={syncingGroups}
              >
                {syncingGroups ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <RefreshCw className="h-3 w-3 mr-1" />
                )}
                Sincronizar
              </Button>
            </div>
            {dashboards.length > 0 ? (
              <>
                {/* Inline (input + lista scrollável), como o picker de contas — NÃO usa portal:
                    SearchableSelect portala pro body e o Radix Dialog (modal) bloqueia foco/scroll dele. */}
                <Input
                  value={groupSearch}
                  onChange={(e) => setGroupSearch(e.target.value)}
                  placeholder="Buscar dashboard por nome ou ID…"
                  className="h-8"
                />
                <div className="h-40 overflow-y-auto rounded-md border p-2 space-y-1">
                  <button
                    type="button"
                    onClick={() => { setGroupId(""); setGroupTouched(true); }}
                    className={cn(
                      "w-full text-left rounded-md px-2 py-1.5 text-sm transition-colors",
                      groupId === "" ? "bg-primary/10 text-primary" : "hover:bg-accent-soft",
                    )}
                  >
                    — Sem grupo —
                  </button>
                  {filteredDashboards.length === 0 ? (
                    <p className="text-sm text-muted-foreground px-2 py-1.5">Nenhum dashboard corresponde à busca.</p>
                  ) : (
                    filteredDashboards.map((d) => (
                      <button
                        key={d.whatsapp_group_id}
                        type="button"
                        onClick={() => { setGroupId(d.whatsapp_group_id); setGroupTouched(true); }}
                        className={cn(
                          "w-full text-left rounded-md px-2 py-1.5 transition-colors",
                          groupId === d.whatsapp_group_id ? "bg-primary/10 text-primary" : "hover:bg-accent-soft",
                        )}
                      >
                        <span className="text-sm block truncate">{d.nome}</span>
                        <span className="text-[10px] text-muted-foreground font-mono">{d.whatsapp_group_id}</span>
                      </button>
                    ))
                  )}
                </div>
                {matchedDashboard && (
                  <p className="text-xs text-muted-foreground">Selecionado: "{matchedDashboard.nome}"</p>
                )}
              </>
            ) : (
              <Input
                value={groupId}
                onChange={(e) => { setGroupId(e.target.value); setGroupTouched(true); }}
                placeholder="ID do grupo (ex: 120363...@g.us)"
              />
            )}
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
              <div className="space-y-1.5">
                <Input
                  value={accountSearch}
                  onChange={(e) => setAccountSearch(e.target.value)}
                  placeholder="Buscar por nome ou ID…"
                  className="h-8"
                />
                <div className="h-48 overflow-y-auto rounded-md border p-2">
                  {filteredAccounts.length === 0 ? (
                    <p className="text-sm text-muted-foreground px-2 py-1.5">Nenhuma conta corresponde à busca.</p>
                  ) : (
                    <div className="space-y-1">
                      {filteredAccounts.map((acc) => {
                        const conflict = accountOwner.get(acc.id);
                        return (
                          <label
                            key={acc.id}
                            className={cn(
                              "flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors",
                              conflict ? "opacity-60 cursor-not-allowed" : "hover:bg-accent-soft cursor-pointer",
                            )}
                          >
                            <Checkbox
                              className="shrink-0"
                              checked={selected.has(acc.id)}
                              disabled={!!conflict}
                              onCheckedChange={() => toggle(acc.id)}
                            />
                            <span className="text-sm flex-1 min-w-0 truncate">{acc.name}</span>
                            {conflict && (
                              <Badge variant="destructive" className="text-[10px] shrink-0">
                                Vinculada a {conflict.clientName}
                              </Badge>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  )}
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
