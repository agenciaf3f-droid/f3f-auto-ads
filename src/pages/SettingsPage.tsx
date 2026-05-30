import { useState, useEffect } from "react";
import Header from "@/components/Header";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertCircle, Loader2, LogIn, Unplug, RefreshCw, AlertTriangle, Plug } from "lucide-react";
import { fetchMetaStatus, getMetaLoginUrl, disconnectMeta } from "@/lib/meta-api";
import { isCurrentUserAdmin } from "@/lib/admin";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";

export default function SettingsPage() {
  const [metaStatus, setMetaStatus] = useState<{
    connected: boolean;
    meta_name?: string;
    expires_at?: string;
    expires_soon?: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    isCurrentUserAdmin().then(setIsAdmin).catch(() => setIsAdmin(false));
  }, []);

  const loadStatus = () => {
    setLoading(true);
    fetchMetaStatus()
      .then(setMetaStatus)
      .catch(() => setMetaStatus({ connected: false }))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadStatus(); }, []);

  const handleConnect = () => {
    sessionStorage.removeItem("meta_status_cache");
    window.location.href = getMetaLoginUrl();
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await disconnectMeta();
      sessionStorage.removeItem("meta_status_cache");
      setMetaStatus({ connected: false });
      toast.success("Conta Meta desconectada");
    } catch {
      toast.error("Erro ao desconectar conta Meta");
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-background">
      <Header />
      <main className="max-w-2xl mx-auto px-4 py-10">

        <div className="mb-8 fade-in-up">
          <h1 className="font-display text-2xl font-bold tracking-tight mb-1.5">Configurações</h1>
          <p className="text-sm text-muted-foreground">Gerencie suas integrações e preferências</p>
        </div>

        {/* Meta connection */}
        <div className="fade-in-up" style={{ animationDelay: "60ms" }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
                <Plug className="w-3.5 h-3.5 text-primary" />
              </div>
              <Label className="font-display font-semibold text-sm">Conexão Meta</Label>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={loadStatus}
              disabled={loading}
              className="h-7 w-7 p-0 text-muted-foreground"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          <div className="glass-card p-6">
            {loading ? (
              <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                Verificando conexão...
              </div>
            ) : metaStatus?.connected ? (
              <div className="space-y-5">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-medium">Conectado</span>
                      {metaStatus.expires_soon && (
                        <Badge
                          variant="outline"
                          className="text-warning border-warning/40 text-[10px] px-1.5 py-0 gap-1 h-4"
                        >
                          <AlertTriangle className="w-2.5 h-2.5" />
                          Expira em breve
                        </Badge>
                      )}
                    </div>
                    {metaStatus.meta_name && (
                      <p className="text-xs text-muted-foreground truncate">{metaStatus.meta_name}</p>
                    )}
                    {metaStatus.expires_at && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Token expira em: {new Date(metaStatus.expires_at).toLocaleDateString("pt-BR")}
                      </p>
                    )}
                  </div>
                </div>

                {isAdmin ? (
                  <div className="flex items-center gap-2 pt-4 border-t border-border/50">
                    <Button variant="outline" size="sm" onClick={handleConnect} className="gap-1.5 text-xs h-8">
                      <Unplug className="w-3.5 h-3.5" />
                      Trocar conta
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleDisconnect}
                      disabled={disconnecting}
                      className="gap-1.5 text-xs h-8 text-destructive hover:text-destructive"
                    >
                      {disconnecting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <LogIn className="w-3.5 h-3.5 rotate-180" />
                      )}
                      Desconectar
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground pt-4 border-t border-border/50">
                    Conexão Meta gerida pela administração. Fale com o admin para alterar.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-5">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium mb-0.5">Desconectado</p>
                    <p className="text-xs text-muted-foreground">
                      {isAdmin
                        ? "Conecte a conta Meta da agência para publicar anúncios"
                        : "Aguardando admin conectar a conta Meta da agência"}
                    </p>
                  </div>
                </div>
                {isAdmin && (
                  <Button onClick={handleConnect} className="gap-2 active:scale-[0.98] transition-transform">
                    <LogIn className="w-4 h-4" />
                    Conectar ao Meta
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

      </main>
    </div>
  );
}
