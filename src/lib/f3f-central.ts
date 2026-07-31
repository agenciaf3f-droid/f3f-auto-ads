import { supabase } from "@/integrations/supabase/client";

// Integração com o login central F3F (Supabase Agenciaf3f).
// O login continua acontecendo neste projeto (RLS/FKs dependem do auth local);
// o central é a fonte de verdade de QUEM tem acesso e da senha única.

// Propaga a senha recém-definida aqui para o central. Best-effort: o update
// local já aconteceu; se o sync falhar só logamos (o próximo reset corrige).
// Retorna se a senha REALMENTE chegou ao central — a edge responde
// { ok:true, synced:false } em silêncio quando os secrets do central faltam,
// quando o usuário não tem conta lá ou quando o update falha. Sem checar isso,
// o espelho diverge e ninguém fica sabendo (foi o que aconteceu em 07-2026).
export async function syncPasswordToCentral(password: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.functions.invoke("f3f-sync-password", {
      body: { password },
    });
    if (error) {
      console.error("[f3f-central] sync de senha falhou:", error.message);
      return false;
    }
    return data?.synced === true;
  } catch (err) {
    console.error("[f3f-central] sync de senha falhou:", err);
    return false;
  }
}

// Pergunta ao central se o usuário continua ativo pro Console.Ads.
// Fail-open: qualquer falha → true (não derruba ninguém por indisponibilidade).
export async function isLoginActive(): Promise<boolean> {
  try {
    const { data, error } = await supabase.functions.invoke("f3f-login-status", {
      body: {},
    });
    if (error || !data) return true;
    return data.active !== false;
  } catch {
    return true;
  }
}
