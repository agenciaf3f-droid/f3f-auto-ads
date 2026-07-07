import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Lock, ArrowRight } from "lucide-react";
import { toast } from "sonner";

// Tela de troca de senha forçada no primeiro login (gestor convidado com senha
// provisória). Ao salvar, limpa a flag must_change_password no user_metadata; o
// AuthContext reage ao USER_UPDATED e o ProtectedRoute libera o app.
export default function FirstLoginPassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      toast.error("As senhas não conferem");
      return;
    }
    if (password.length < 6) {
      toast.error("A senha precisa ter pelo menos 6 caracteres");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({
        password,
        data: { must_change_password: false },
      });
      if (error) throw error;
      toast.success("Senha criada! Bem-vindo(a).");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar senha");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm fade-in-up">

        <div className="mb-8 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/15 border border-primary/20 flex items-center justify-center">
            <Lock className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h1 className="font-display text-xl font-bold tracking-tight">Criar nova senha</h1>
            <p className="text-xs text-muted-foreground">Defina uma senha para acessar sua conta</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Nova senha</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mínimo 6 caracteres"
              required
              minLength={6}
              className="h-10"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Confirmar senha</Label>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repita a senha"
              required
              minLength={6}
              className="h-10"
            />
          </div>

          <Button
            type="submit"
            className="w-full h-10 gap-2 mt-2 active:scale-[0.98] transition-transform"
            disabled={loading}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
            Salvar senha
          </Button>
        </form>
      </div>
    </div>
  );
}
