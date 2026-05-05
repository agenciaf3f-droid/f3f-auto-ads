import PublishForm from "@/components/PublishForm";
import Header from "@/components/Header";
import { Megaphone } from "lucide-react";

const Index = () => {
  return (
    <div className="min-h-[100dvh] bg-background">
      <Header />
      <main className="max-w-2xl mx-auto px-4 py-10">
        <div className="mb-8 fade-in-up">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-7 h-7 rounded-md bg-accent/15 border border-accent/20 flex items-center justify-center">
              <Megaphone className="w-3.5 h-3.5 text-accent" />
            </div>
            <span className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
              Nova publicação
            </span>
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight mb-1.5">
            Publicar <span className="text-gradient">Anúncio</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Configure e publique seu anúncio no Meta Ads em poucos passos
          </p>
        </div>
        <div className="fade-in-up" style={{ animationDelay: "60ms" }}>
          <PublishForm />
        </div>
      </main>
    </div>
  );
};

export default Index;
