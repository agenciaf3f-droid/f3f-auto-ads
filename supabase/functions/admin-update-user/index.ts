// Edge function: admin edita um gestor (nome e/ou senha).
// Acesso restrito: caller precisa estar em public.app_admins.
//
// EMAIL NÃO É EDITÁVEL AQUI, de propósito: o email é a ÚNICA chave de junção entre
// este projeto e o login central F3F (f3f-sync-password, f3f-login-status,
// admin-remove-user e as edges do central casam por email). Trocar o email só de um
// lado quebra sync de senha, desativação e remoção — tudo em silêncio. Troca de email
// = remover + convidar.
//
// A senha definida pelo admin é propagada ao central (a credencial é única entre os
// sistemas F3F). Falha na propagação NÃO é silenciosa: volta central_synced:false e a
// UI avisa — o oposto do bug que gerou o PR #110.
// Sem entrada em config.toml => verify_jwt=true (default) protege.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Piso de 8: o central (f3f-auth-set-password) recusa senha < 8. Aceitar 6 aqui
// deixaria passar senha que o central rejeita → espelho divergente.
const MIN_PASSWORD = 8;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Mesmo helper de f3f-sync-password: o central não tem lookup por email na admin API.
async function findUserByEmail(admin: SupabaseClient, email: string) {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers central: ${error.message}`);
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return json({ error: "Não autenticado" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1. Validar caller via JWT.
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) {
      console.log("[admin-update-user] Auth error:", authError?.message);
      return json({ error: "Sessão inválida" }, 401);
    }

    // 2. Verificar se caller é admin (via service role para bypassar RLS).
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: adminRow } = await adminClient
      .from("app_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!adminRow) {
      console.log("[admin-update-user] Caller não é admin:", user.id);
      return json({ error: "Apenas administradores podem editar gestores" }, 403);
    }

    // 3. Validar body.
    const body = await req.json().catch(() => ({}));
    const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
    const rawName = typeof body.name === "string" ? body.name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!userId) return json({ error: "user_id obrigatório" }, 400);
    if (!rawName && !password) {
      return json({ error: "Informe ao menos um campo para alterar" }, 400);
    }
    if (rawName && rawName.length < 2) {
      return json({ error: "Nome precisa ter pelo menos 2 caracteres" }, 400);
    }
    if (password && password.length < MIN_PASSWORD) {
      return json({ error: `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres` }, 400);
    }

    // 4. Alvo precisa existir. Guarda o email/metadata atuais (email é imutável aqui,
    // e serve pra achar a mesma pessoa no central).
    const { data: targetRes, error: getErr } = await adminClient.auth.admin.getUserById(userId);
    if (getErr || !targetRes?.user) {
      return json({ error: "Gestor não encontrado" }, 404);
    }
    const target = targetRes.user;
    const targetEmail = (target.email ?? "").toLowerCase();

    // 5. Atualizar no projeto local (csfpq). O nome mora em user_metadata.name
    // (a tabela profiles está morta neste codebase). Merge pra não apagar outras flags
    // do metadata (ex.: must_change_password).
    const localPatch: { password?: string; user_metadata?: Record<string, unknown> } = {};
    const meta: Record<string, unknown> = { ...(target.user_metadata ?? {}) };
    let touchedMeta = false;

    if (password) {
      localPatch.password = password;
      // A senha definida pelo admin é a definitiva (padronização via Bitwarden): limpa a
      // flag de primeiro acesso, senão o gestor cairia no FirstLoginPassword e trocaria
      // justamente a senha que o admin acabou de padronizar.
      meta.must_change_password = false;
      touchedMeta = true;
    }
    if (rawName) {
      meta.name = rawName;
      touchedMeta = true;
    }
    if (touchedMeta) localPatch.user_metadata = meta;

    const { error: updErr } = await adminClient.auth.admin.updateUserById(userId, localPatch);
    if (updErr) {
      console.error("[admin-update-user] updateUserById local falhou:", updErr.message);
      return json({ error: updErr.message }, 500);
    }

    // 6. Só senha exige propagação/revogação. Nome é local (o central mantém a cópia dele).
    let centralSynced: boolean | undefined;
    // Acumula: revogação de sessão e sync central falham de forma independente. Guardar só
    // o primeiro aviso esconderia o outro — e "senha não propagou" sumindo em silêncio é
    // exatamente o bug do PR #110.
    const warnings: string[] = [];

    if (password) {
      // 6a. Revogar sessões ativas: quem estiver logado com a senha antiga cai.
      // updateUserById NÃO derruba sessão, e auth.admin.signOut() exige o JWT do
      // próprio usuário (que o admin não tem) — daí a função SECURITY DEFINER.
      const { error: revokeErr } = await adminClient.rpc("admin_revoke_sessions", {
        p_user_id: userId,
      });
      if (revokeErr) {
        // Não derruba a operação: a senha JÁ mudou. Só avisa.
        console.error("[admin-update-user] revogar sessões falhou:", revokeErr.message);
        warnings.push("As sessões ativas do usuário não foram encerradas.");
      }

      // 6b. Propagar a senha para o login central F3F (credencial única entre sistemas).
      const centralUrl = Deno.env.get("F3F_CENTRAL_URL");
      const centralKey = Deno.env.get("F3F_CENTRAL_SERVICE_ROLE_KEY");
      if (!centralUrl || !centralKey || !targetEmail) {
        centralSynced = false;
        warnings.push("A senha não propagou para os outros sistemas F3F (central não configurado).");
        console.log("[admin-update-user] central não configurado — pulando sync");
      } else {
        try {
          const central = createClient(centralUrl, centralKey);
          const centralUser = await findUserByEmail(central, targetEmail);
          if (!centralUser) {
            centralSynced = false;
            warnings.push("A senha não propagou: este usuário não existe no login central F3F.");
            console.log("[admin-update-user] sem conta central:", targetEmail);
          } else {
            const { error: cErr } = await central.auth.admin.updateUserById(centralUser.id, {
              password,
              user_metadata: { ...centralUser.user_metadata, must_change_password: false },
            });
            if (cErr) {
              centralSynced = false;
              warnings.push(`A senha não propagou para os outros sistemas F3F: ${cErr.message}`);
              console.error("[admin-update-user] update central falhou:", cErr.message);
            } else {
              centralSynced = true;
              console.log("[admin-update-user] senha sincronizada no central:", targetEmail);
            }
          }
        } catch (err) {
          centralSynced = false;
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(`A senha não propagou para os outros sistemas F3F: ${msg}`);
          console.error("[admin-update-user] sync central falhou:", msg);
        }
      }
    }

    console.log(
      `[admin-update-user] Gestor ${userId} editado por ${user.id}`,
      `(nome=${!!rawName}, senha=${!!password}, central_synced=${centralSynced})`,
    );
    // Prefixo "Senha alterada," só quando há aviso — deixa claro que a operação local
    // deu certo e o que falhou foi um efeito colateral.
    const warning = warnings.length ? `Senha alterada, mas: ${warnings.join(" ")}` : undefined;
    return json({ ok: true, central_synced: centralSynced, warning });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[admin-update-user] Unexpected error:", msg);
    return json({ error: msg }, 500);
  }
});
