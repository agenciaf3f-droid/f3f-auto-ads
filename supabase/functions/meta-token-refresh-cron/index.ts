import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Cron diário: refresca tokens Meta que expiram em ≤ 14 dias.
// Mantém conexão viva sem depender de admin abrir o app.
Deno.serve(async (req) => {
  // Proteção simples: exige header de cron secret
  const cronSecret = Deno.env.get("CRON_SECRET");
  const provided = req.headers.get("x-cron-secret");
  if (cronSecret && provided !== cronSecret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const appId = "910343951738258";
  const appSecret = Deno.env.get("META_APP_SECRET");
  if (!appSecret) {
    return new Response(JSON.stringify({ error: "META_APP_SECRET not set" }), { status: 500 });
  }

  const now = new Date();
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  const threshold = new Date(now.getTime() + fourteenDaysMs).toISOString();

  const { data: conns, error } = await adminClient
    .from("meta_connections")
    .select("id, user_id, access_token, expires_at")
    .lte("expires_at", threshold);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const results: any[] = [];
  for (const conn of conns || []) {
    try {
      const url = `https://graph.facebook.com/v25.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${conn.access_token}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.access_token) {
        const newExpiresIn = data.expires_in || 5184000;
        const newExpiresAt = new Date(Date.now() + newExpiresIn * 1000).toISOString();
        const { error: updErr } = await adminClient
          .from("meta_connections")
          .update({ access_token: data.access_token, expires_at: newExpiresAt })
          .eq("id", conn.id);
        results.push({ id: conn.id, refreshed: !updErr, new_expires_at: newExpiresAt, update_err: updErr?.message });
      } else {
        results.push({ id: conn.id, refreshed: false, meta_error: data.error?.message || JSON.stringify(data) });
      }
    } catch (e) {
      results.push({ id: conn.id, refreshed: false, exception: (e as Error).message });
    }
  }

  return new Response(JSON.stringify({ scanned: conns?.length || 0, results }), {
    headers: { "Content-Type": "application/json" },
  });
});
