import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, UserPlus, Mail, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { isCurrentUserAdmin, inviteUser } from "@/lib/admin";

export default function AdminPage() {
  const navigate = useNavigate();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

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

    </div>
  );
}
