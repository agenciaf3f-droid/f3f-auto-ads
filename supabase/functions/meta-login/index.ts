import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req) => {
  const appId = "910343951738258";
  const appUrl = Deno.env.get("APP_URL") ?? "https://console.agenciaf3f.com.br";
  const redirectUri = `${appUrl}/auth/meta/callback`;
  // whatsapp_business_management: necessário pra ler WABA + phone_numbers (FASE 3 CTW).
  // App Meta já tem essa permissão habilitada (confirmado no painel).
  const scopes = "ads_management,ads_read,business_management,pages_show_list,pages_read_engagement,instagram_basic,whatsapp_business_management";
  const state = new URL(req.url).searchParams.get("state") ?? crypto.randomUUID();

  // auth_type=rerequest força Facebook a re-prompt todas as permissões
  // mesmo se user já autorizou (necessário quando adicionamos novos scopes).
  const url = `https://www.facebook.com/v25.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&response_type=code&state=${state}&auth_type=rerequest`;

  return new Response(null, {
    status: 302,
    headers: { Location: url },
  });
});
