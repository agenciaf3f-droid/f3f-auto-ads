import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, ArrowRight } from "lucide-react";
import { toast } from "sonner";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      toast.success("Login realizado!");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Erro na autenticação");
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async () => {
    if (!email || !email.includes("@")) {
      toast.error("Digite seu email primeiro para receber o link");
      return;
    }
    setResetting(true);
    try {
      const redirectTo = `${window.location.origin}/auth/reset-password`;
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw error;
      toast.success("Enviamos um link de redefinição para seu email");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Erro ao solicitar redefinição");
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col md:flex-row">

      {/* Mobile header — compact brand */}
      <div className="md:hidden bg-zinc-950 px-6 py-4 border-b border-white/10">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="F3F ADS" className="h-11 w-auto" />
        </div>
      </div>

      {/* Left panel — brand story */}
      <div className="relative md:w-[52%] bg-zinc-950 flex-col justify-between p-8 md:p-12 hidden md:flex md:min-h-[100dvh] overflow-hidden">

        <div
          className="absolute inset-0 opacity-[0.14] pointer-events-none"
          style={{
            backgroundImage: "radial-gradient(circle at 25% 15%, hsl(271 91% 60%) 0%, transparent 55%), radial-gradient(circle at 85% 85%, hsl(288 85% 55%) 0%, transparent 55%)",
          }}
        />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,_rgba(255,255,255,0.03)_0%,_transparent_50%)] pointer-events-none" />

        <div className="relative flex items-center gap-2.5 fade-in-up" style={{ animationDelay: "0ms" }}>
          <img src="/logo.png" alt="F3F ADS" className="h-11 w-auto" />
        </div>

        <div className="relative space-y-8 my-auto py-10 md:py-0">
          <div className="fade-in-up" style={{ animationDelay: "80ms" }}>
            <p className="text-xs font-medium tracking-widest text-primary/80 uppercase mb-3">
              Para gestores de tráfego
            </p>
            <h1 className="font-display text-3xl md:text-4xl font-bold text-white leading-tight tracking-tight">
              Campanhas no Meta<br />
              <span className="text-gradient">sem abrir o Gerenciador.</span>
            </h1>
          </div>

        </div>

        <p className="relative text-xs text-white/20 fade-in-up" style={{ animationDelay: "480ms" }}>
          Meta Graph API v25.0 — FASE 1 &amp; FASE 3
        </p>
      </div>

      {/* Right panel — login form */}
      <div className="flex-1 flex items-center justify-center px-6 md:px-8 py-12 md:py-0 bg-background">
        <div className="w-full max-w-sm fade-in-up" style={{ animationDelay: "120ms" }}>

          <div className="mb-8">
            <h2 className="font-display text-2xl font-bold tracking-tight mb-1.5">Acessar plataforma</h2>
            <p className="text-sm text-muted-foreground">Bem-vindo de volta</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label className="text-sm font-medium">Email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="seu@email.com"
                required
                className="h-10"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Senha</Label>
                <button
                  type="button"
                  onClick={handleResetPassword}
                  disabled={resetting}
                  className="text-xs text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                >
                  {resetting ? "Enviando..." : "Esqueci minha senha"}
                </button>
              </div>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
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
              Entrar
            </Button>
          </form>

          <div className="mt-6 pt-6 border-t border-border/50">
            <p className="text-center text-xs text-muted-foreground">
              Acesso restrito. Solicite seu cadastro com o administrador.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
