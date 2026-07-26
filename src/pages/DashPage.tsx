import { useEffect, useState } from "react";
import { LayoutDashboard, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { toast } from "sonner";
import { fetchMetaStatus, fetchIgAccountsForAdAccount } from "@/lib/meta-api";
import { listClients, listClientAdAccounts, type Client } from "@/lib/clients";
import { listDashItems, syncDashContent, updateStudentName, type DashItem, type DashProfile } from "@/lib/dash";

const fmtCount = (n: number | null) => (n == null ? "—" : n.toLocaleString("pt-BR"));

export default function DashPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState("");
  const [items, setItems] = useState<DashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [token, setToken] = useState<string | undefined>();
  // Dado de conta (teste) — não persistido, só o que veio do último Sincronizar desta sessão.
  const [profile, setProfile] = useState<DashProfile | null>(null);

  useEffect(() => {
    listClients().then((cs) => { setClients(cs); if (cs.length > 0) setClientId(cs[0].id); })
      .catch((e) => toast.error((e as Error).message));
    fetchMetaStatus().then((s) => setToken(s.connected ? s.access_token : undefined)).catch(() => setToken(undefined));
  }, []);

  const load = async (id: string) => {
    if (!id) { setLoading(false); return; }
    setLoading(true);
    try {
      setItems(await listDashItems(id));
    } catch (e) {
      toast.error((e as Error).message || "Erro ao carregar dash");
    } finally {
      setLoading(false);
    }
  };
  // Só a TROCA de cliente invalida o perfil da sessão anterior — load() sozinho (ex.: chamado de
  // novo ao fim do handleSync pra refletir os posts recém-sincronizados) não deve limpar o
  // profile que acabou de ser setado pelo mesmo sync.
  useEffect(() => { setProfile(null); load(clientId); }, [clientId]);

  const handleSync = async () => {
    if (!clientId || !token) { toast.error("Conecte o Meta antes de sincronizar."); return; }
    setSyncing(true);
    try {
      const accounts = await listClientAdAccounts(clientId);
      if (accounts.length === 0) throw new Error("Vincule uma conta de anúncio a este cliente primeiro.");
      const { ig_accounts } = await fetchIgAccountsForAdAccount(token, accounts[0].ad_account_id);
      if (ig_accounts.length === 0) throw new Error("Nenhuma conta do Instagram encontrada para essa conta de anúncio.");
      const result = await syncDashContent(clientId, token, ig_accounts[0].ig_account_id);
      toast.success(`${result.synced} posts sincronizados`);
      if (result.views_rate_limited) toast.warning(result.views_warning || "Limite de requisições da Meta atingido ao buscar views.");
      setProfile(result.profile || null);
      await load(clientId);
    } catch (e) {
      toast.error((e as Error).message || "Erro ao sincronizar");
    } finally {
      setSyncing(false);
    }
  };

  const handleStudentNameBlur = async (item: DashItem, value: string) => {
    if (value === (item.student_name || "")) return;
    try {
      await updateStudentName(item.id, value);
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, student_name: value } : i)));
    } catch (e) {
      toast.error((e as Error).message || "Erro ao salvar nome do aluno");
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      <div className="mb-8 fade-in-up flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-7 h-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
              <LayoutDashboard className="w-3.5 h-3.5 text-primary" />
            </div>
            <span className="text-xs font-medium text-muted-foreground tracking-wide uppercase">Dash</span>
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight mb-1.5">
            Conteúdo <span className="text-gradient">Instagram</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Posts e reels do Instagram do cliente com engajamento, sincronizados sob demanda da Meta.
          </p>
        </div>
        <div className="flex items-end gap-2 shrink-0">
          <div className="space-y-1.5 w-56">
            <label className="text-xs font-medium text-muted-foreground">Cliente</label>
            <Select value={clientId} onValueChange={setClientId}>
              <SelectTrigger><SelectValue placeholder="Selecione um cliente" /></SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleSync} disabled={syncing || !clientId} className="gap-1.5 shrink-0">
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sincronizar
          </Button>
        </div>
      </div>

      {profile && (
        <div className="mb-6 fade-in-up rounded-lg border p-4">
          <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase mb-2">Perfil:</p>
          <div className="flex items-center gap-3 mb-3">
            {profile.profile_picture_url && (
              <img src={profile.profile_picture_url} alt={profile.username || "perfil"} className="w-10 h-10 rounded-full object-cover" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">@{profile.username || "—"}</p>
              <p className="text-xs text-muted-foreground truncate">{profile.name || ""}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
            <div><span className="text-muted-foreground">Seguidores: </span>{fmtCount(profile.followers_count ?? null)}</div>
            <div><span className="text-muted-foreground">Seguindo: </span>{fmtCount(profile.follows_count ?? null)}</div>
            <div><span className="text-muted-foreground">Posts: </span>{fmtCount(profile.media_count ?? null)}</div>
            <div><span className="text-muted-foreground">Alcance (7d): </span>{fmtCount(profile.insights_7d?.reach ?? null)}</div>
            <div><span className="text-muted-foreground">Visitas ao perfil (7d): </span>{fmtCount(profile.insights_7d?.profile_views ?? null)}</div>
            <div><span className="text-muted-foreground">Contas engajadas (7d): </span>{fmtCount(profile.insights_7d?.accounts_engaged ?? null)}</div>
          </div>
          {profile.insights_error && (
            <p className="text-xs text-destructive mt-3">⚠️ Insights de conta: {profile.insights_error}</p>
          )}
          {profile.biography && <p className="text-xs text-muted-foreground mt-3 whitespace-pre-wrap">{profile.biography}</p>}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground fade-in-up">
          <LayoutDashboard className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <p className="text-sm">Nenhum conteúdo sincronizado ainda. Clique em "Sincronizar" para buscar os posts do Instagram.</p>
        </div>
      ) : (
        <div className="fade-in-up rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead>Data</TableHead>
                <TableHead className="text-right">Likes</TableHead>
                <TableHead className="text-right">Comentários</TableHead>
                <TableHead className="text-right">Views</TableHead>
                <TableHead>Aluno</TableHead>
                <TableHead>Legenda</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="whitespace-nowrap">{item.media_product_type || item.media_type || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {item.posted_at ? new Date(item.posted_at).toLocaleDateString("pt-BR") : "—"}
                  </TableCell>
                  <TableCell className="text-right">{fmtCount(item.like_count)}</TableCell>
                  <TableCell className="text-right">{fmtCount(item.comments_count)}</TableCell>
                  <TableCell className="text-right">{fmtCount(item.views_count)}</TableCell>
                  <TableCell>
                    <Input
                      defaultValue={item.student_name || ""}
                      placeholder="Nome do aluno"
                      className="h-8 w-36"
                      onBlur={(e) => handleStudentNameBlur(item, e.target.value)}
                    />
                  </TableCell>
                  <TableCell className="max-w-[20rem] truncate" title={item.caption || undefined}>
                    {item.caption || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
