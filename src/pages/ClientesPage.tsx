import { useEffect, useState } from "react";
import { Users, Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { fetchMetaStatus } from "@/lib/meta-api";
import { listClients, listClientAdAccounts, deleteClient, type Client, type ClientAdAccount } from "@/lib/clients";
import ClientCard from "@/components/clients/ClientCard";
import ClientForm from "@/components/clients/ClientForm";
import ClientKpiRulesEditor from "@/components/clients/ClientKpiRulesEditor";
import ClientKpiDashboard from "@/components/clients/ClientKpiDashboard";

export default function ClientesPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [linksByClient, setLinksByClient] = useState<Record<string, ClientAdAccount[]>>({});
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState<string | undefined>();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [detail, setDetail] = useState<Client | null>(null);
  const [toDelete, setToDelete] = useState<Client | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [cs, links] = await Promise.all([listClients(), listClientAdAccounts()]);
      setClients(cs);
      const grouped: Record<string, ClientAdAccount[]> = {};
      for (const l of links) (grouped[l.client_id] ||= []).push(l);
      setLinksByClient(grouped);
    } catch (e) {
      toast.error((e as Error).message || "Erro ao carregar clientes");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    fetchMetaStatus()
      .then((s) => setToken(s.connected ? s.access_token : undefined))
      .catch(() => setToken(undefined));
  }, []);

  const handleDelete = async () => {
    if (!toDelete) return;
    try {
      await deleteClient(toDelete.id);
      toast.success("Cliente removido");
      setToDelete(null);
      load();
    } catch (e) {
      toast.error((e as Error).message || "Erro ao remover");
    }
  };

  const detailLinks = detail ? linksByClient[detail.id] || [] : [];

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <div className="mb-8 fade-in-up flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-7 h-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Users className="w-3.5 h-3.5 text-primary" />
            </div>
            <span className="text-xs font-medium text-muted-foreground tracking-wide uppercase">Clientes</span>
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight mb-1.5">
            Gestão de <span className="text-gradient">Clientes</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Cadastre clientes, vincule contas de anúncio e defina limites de KPI por preset de campanha.
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setFormOpen(true); }} className="gap-1.5 shrink-0">
          <Plus className="h-4 w-4" /> Adicionar cliente
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
        </div>
      ) : clients.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground fade-in-up">
          <Users className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <p className="text-sm">Nenhum cliente ainda. Clique em "Adicionar cliente" para começar.</p>
        </div>
      ) : (
        <div className="space-y-2 fade-in-up">
          {clients.map((c) => (
            <ClientCard
              key={c.id}
              client={c}
              accountCount={(linksByClient[c.id] || []).length}
              onManage={() => setDetail(c)}
              onEdit={() => { setEditing(c); setFormOpen(true); }}
              onDelete={() => setToDelete(c)}
            />
          ))}
        </div>
      )}

      <ClientForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={load}
        accessToken={token}
        client={editing}
      />

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detail?.name}</DialogTitle>
          </DialogHeader>
          {detail && (
            <Tabs defaultValue="dashboard">
              <TabsList className="grid grid-cols-2 w-full">
                <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
                <TabsTrigger value="kpis">Configurar KPIs</TabsTrigger>
              </TabsList>
              <TabsContent value="dashboard" className="pt-3">
                <ClientKpiDashboard adAccounts={detailLinks} accessToken={token} />
              </TabsContent>
              <TabsContent value="kpis" className="pt-3">
                <ClientKpiRulesEditor adAccounts={detailLinks} />
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover cliente?</AlertDialogTitle>
            <AlertDialogDescription>
              "{toDelete?.name}" e todas as contas vinculadas e regras de KPI serão removidas. Não afeta nada no Meta.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Remover</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
