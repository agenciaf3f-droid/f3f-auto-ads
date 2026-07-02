import { Users } from "lucide-react";

export default function ClientesPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <div className="mb-8 fade-in-up">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-7 h-7 rounded-md bg-accent/15 border border-accent/20 flex items-center justify-center">
            <Users className="w-3.5 h-3.5 text-accent" />
          </div>
          <span className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
            Em breve
          </span>
        </div>
        <h1 className="font-display text-2xl font-bold tracking-tight mb-1.5">
          Gestão de <span className="text-gradient">Clientes</span>
        </h1>
        <p className="text-sm text-muted-foreground">
          Em breve você vai poder organizar seus clientes e vincular campanhas a cada um deles direto por aqui.
        </p>
      </div>
    </div>
  );
}
