import { useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404: rota inexistente acessada:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="text-left max-w-xs fade-in-up">
        <p className="font-display text-7xl font-bold text-primary/40 mb-4 leading-none">404</p>
        <h1 className="font-display text-xl font-bold mb-2 tracking-tight">Página não encontrada</h1>
        <p className="text-sm text-muted-foreground mb-6">
          A rota <code className="text-xs bg-muted/60 px-1.5 py-0.5 rounded border border-border/40">{location.pathname}</code> não existe.
        </p>
        <a href="/">
          <Button size="sm" className="gap-2">
            <ArrowLeft className="w-3.5 h-3.5" />
            Voltar ao início
          </Button>
        </a>
      </div>
    </div>
  );
};

export default NotFound;
