import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Loader2, UserPlus, Mail, ShieldCheck, Users, Trash2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { isCurrentUserAdmin, inviteUser, listAppUsers, removeAppUser, type AppUser } from "@/lib/admin";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("pt-BR");
  } catch {
    return "—";
  }
}

export default function AdminPage() {
  const navigate = useNavigate();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    isCurrentUserAdmin().then((ok) => {
      setAllowed(ok);
      if (!ok) {
        toast.error("Acesso restrito a administradores");
        navigate("/", { replace: true });
      }
    });
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await inviteUser(email, name);
      toast.success(`Convite enviado para ${email}`);
      setEmail("");
      setName("");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Erro ao enviar convite");
    } finally {
      setSubmitting(false);
    }
  };

  const loadUsers = async () => {
    setLoadingUsers(true);
    try {
      setUsers(await listAppUsers());
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Erro ao carregar gestores");
    } finally {
      setLoadingUsers(false);
    }
  };

  // Carrega a lista assim que o acesso admin é confirmado.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (allowed) loadUsers(); }, [allowed]);

  const handleRemove = async (id: string, label: string) => {
    setRemovingId(id);
    try {
      await removeAppUser(id);
      toast.success(`Gestor ${label} removido`);
      setUsers((prev) => prev.filter((u) => u.id !== id));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Erro ao remover gestor");
    } finally {
      setRemovingId(null);
    }
  };

  if (allowed === null) {
    // Sem min-h-[100dvh]/bg-background aqui — AppLayout (SidebarInset) já fornece isso;
    // duplicar empurrava o spinner pra fora do centro (altura somada em cima da do layout).
    return (
      <div className="flex items-center justify-center py-24">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground font-medium">Verificando acesso...</p>
        </div>
      </div>
    );
  }
  if (!allowed) return null;

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">

      <div className="mb-8 fade-in-up">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-7 h-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
              <ShieldCheck className="w-3.5 h-3.5 text-primary" />
            </div>
            <span className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
              Painel administrativo
            </span>
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight mb-1.5">
            Convidar <span className="text-gradient">gestor</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            O gestor receberá um email com a senha provisória e poderá entrar imediatamente.
          </p>
        </div>

        <div className="glass-card p-6 fade-in-up" style={{ animationDelay: "60ms" }}>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Nome do gestor</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Maria Silva"
                required
                minLength={2}
                className="h-10"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="gestor@email.com"
                required
                className="h-10"
              />
              <p className="text-xs text-muted-foreground">
                A senha provisória será enviada para este email.
              </p>
            </div>

            <Button
              type="submit"
              className="w-full h-10 gap-2 active:scale-[0.98] transition-transform"
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <UserPlus className="w-4 h-4" />
              )}
              Enviar convite
            </Button>
          </form>
        </div>

        <div className="mt-6 flex items-start gap-2.5 text-xs text-muted-foreground fade-in-up" style={{ animationDelay: "120ms" }}>
          <Mail className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <p>
            O email é enviado via Resend a partir de <code className="text-foreground/80">noreply@agenciaf3f.com.br</code>.
            Se não chegar em alguns minutos, pedir para o gestor verificar a caixa de spam.
          </p>
        </div>

        {/* ── Seção Gestores: lista + remoção de membros ── */}
        <div className="glass-card p-6 mt-6 fade-in-up" style={{ animationDelay: "180ms" }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-primary" />
              <h2 className="font-display text-lg font-semibold tracking-tight">Gestores</h2>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={loadUsers}
              disabled={loadingUsers}
              className="gap-1.5 text-xs h-8"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingUsers ? "animate-spin" : ""}`} />
              Atualizar
            </Button>
          </div>

          {loadingUsers ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
              <Loader2 className="w-4 h-4 animate-spin" />
              Carregando gestores...
            </div>
          ) : users.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6">Nenhum gestor encontrado.</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {users.map((u) => {
                const isSelf = currentUser?.id === u.id;
                const label = u.name || u.email || "gestor";
                return (
                  <li key={u.id} className="flex items-center gap-3 py-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{u.name || "—"}</span>
                        {u.is_admin && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-1">
                            <ShieldCheck className="w-2.5 h-2.5" />
                            Admin
                          </Badge>
                        )}
                        {isSelf && <span className="text-[10px] text-muted-foreground">(você)</span>}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{u.email || "—"}</p>
                      <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                        Criado em {fmtDate(u.created_at)}
                        {u.last_sign_in_at
                          ? ` · último acesso ${fmtDate(u.last_sign_in_at)}`
                          : " · nunca acessou"}
                      </p>
                    </div>

                    {isSelf ? (
                      <span className="text-[11px] text-muted-foreground shrink-0 px-2">—</span>
                    ) : (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={removingId === u.id}
                            className="text-destructive hover:text-destructive gap-1.5 h-8 shrink-0"
                          >
                            {removingId === u.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="w-3.5 h-3.5" />
                            )}
                            Remover
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remover gestor?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Remover <strong>{label}</strong>? Isso apaga o acesso dele à plataforma. Ação irreversível.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancelar</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleRemove(u.id, label)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Remover
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

    </div>
  );
}
