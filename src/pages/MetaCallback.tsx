import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { exchangeCodeForToken } from "@/lib/meta-api";
import { Loader2, AlertCircle } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

export default function MetaCallback() {
  const REDIRECT_URI = `${window.location.origin}/auth/meta/callback`;
  const navigate = useNavigate();
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");

    if (!code) {
      setError("Código de autorização não encontrado.");
      return;
    }

    // Validação de state (CSRF): compara com o valor gerado pelo cliente antes do redirect.
    // Single-use — remove independente do resultado.
    const expectedState = sessionStorage.getItem("meta_oauth_state");
    sessionStorage.removeItem("meta_oauth_state");
    if (!expectedState || state !== expectedState) {
      setError("Falha de segurança na autenticação — tente novamente.");
      return;
    }

    // Clear cache before exchanging
    sessionStorage.removeItem("meta_status_cache");

    // The edge function will save the token to DB using the auth header automatically
    exchangeCodeForToken(code, REDIRECT_URI)
      .then((data) => {
        console.log("[MetaCallback] Token exchange result:", {
          hasToken: !!data.access_token,
          isLongLived: data.is_long_lived,
          savedToDb: data.saved_to_db,
          expiresIn: data.expires_in,
        });
        if (!data.access_token) {
          setError("Token não retornado pelo servidor.");
          return;
        }
        if (data.saved_to_db === false) {
          setError("Conectado ao Meta, mas não foi possível salvar a conexão. Tente novamente ou faça login de novo.");
          return;
        }
        navigate("/");
      })
      .catch((err) => setError(err.message));
  }, [navigate]);

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Alert variant="destructive" className="max-w-md">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle className="font-display font-semibold">Erro na autenticação</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{error}</p>
            <a href="/" className="text-destructive hover:underline text-sm inline-block">Voltar</a>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="flex items-center gap-3 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="font-display text-sm">Autenticando com o Meta...</span>
      </div>
    </div>
  );
}
