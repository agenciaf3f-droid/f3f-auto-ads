import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      console.log("[meta-status] No auth header");
      return new Response(JSON.stringify({ connected: false, reason: "no_auth" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      console.log("[meta-status] No user from auth header");
      return new Response(JSON.stringify({ connected: false, reason: "no_user" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // SHARED CONNECTION MODEL: usa o token de qualquer admin (ex.: Lulu Eiras / agencia mãe).
    // Todos os gestores compartilham a mesma conexão Meta — não há isolamento Meta por gestor.
    // O isolamento de F3F-AUTO-ADS continua por user_id (cada gestor tem seu login Supabase).
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: adminRow } = await adminClient
      .from("app_admins")
      .select("user_id")
      .limit(1)
      .maybeSingle();
    const sharedUserId = adminRow?.user_id ?? user.id;

    const { data: conn } = await adminClient
      .from("meta_connections")
      .select("access_token, expires_at")
      .eq("user_id", sharedUserId)
      .maybeSingle();

    if (!conn) {
      console.log("[meta-status] No meta_connection found for user:", user.id);
      return new Response(JSON.stringify({ connected: false, reason: "no_connection" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if expired
    const now = new Date();
    const expiresAt = conn.expires_at ? new Date(conn.expires_at) : null;
    const isExpired = expiresAt && expiresAt < now;

    if (isExpired) {
      console.log("[meta-status] Token expired at:", conn.expires_at);
      return new Response(JSON.stringify({ connected: false, reason: "expired" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if token expires within 7 days (warn but still connected)
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const expiresSoon = expiresAt && (expiresAt.getTime() - now.getTime()) < sevenDaysMs;

    // Parse request body to check if caller wants full verification
    let forceVerify = false;
    try {
      const body = await req.json();
      forceVerify = body?.force_verify === true;
    } catch {
      // No body or invalid JSON — that's fine
    }

    // Only verify with Meta API if forced or token expires within 7 days
    // This avoids hitting Meta API on every single page load
    let metaName: string | null = null;
    let currentToken = conn.access_token;
    let currentExpiresAt = conn.expires_at;
    let refreshed = false;

    if (forceVerify || expiresSoon) {
      console.log("[meta-status] Verifying token with Meta API (force:", forceVerify, ", expiresSoon:", expiresSoon, ")");
      const meRes = await fetch(`https://graph.facebook.com/v25.0/me?fields=name&access_token=${conn.access_token}`);
      const meData = await meRes.json();

      if (meData.error) {
        console.log("[meta-status] Meta API error:", meData.error);
        return new Response(JSON.stringify({ connected: false, reason: "invalid_token", error: meData.error.message }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      metaName = meData.name;

      // AUTO-REFRESH: trocar long-lived token por novo long-lived (mais ~60 dias)
      // antes de expirar. Mantém conexão viva enquanto admin abrir o app a cada ~53 dias.
      if (expiresSoon) {
        const appId = "910343951738258";
        const appSecret = Deno.env.get("META_APP_SECRET");
        if (appSecret) {
          try {
            const refreshUrl = `https://graph.facebook.com/v25.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${conn.access_token}`;
            const refreshRes = await fetch(refreshUrl);
            const refreshData = await refreshRes.json();
            if (refreshData.access_token) {
              const newExpiresIn = refreshData.expires_in || 5184000; // ~60 dias
              const newExpiresAt = new Date(Date.now() + newExpiresIn * 1000).toISOString();
              const { error: updateErr } = await adminClient
                .from("meta_connections")
                .update({ access_token: refreshData.access_token, expires_at: newExpiresAt })
                .eq("user_id", sharedUserId);
              if (!updateErr) {
                currentToken = refreshData.access_token;
                currentExpiresAt = newExpiresAt;
                refreshed = true;
                console.log("[meta-status] ✅ Token refreshed. New expires_at:", newExpiresAt);
              } else {
                console.error("[meta-status] Failed to save refreshed token:", updateErr);
              }
            } else {
              console.warn("[meta-status] Refresh did not return access_token:", refreshData);
            }
          } catch (e) {
            console.error("[meta-status] Refresh exception:", (e as Error).message);
          }
        } else {
          console.warn("[meta-status] META_APP_SECRET not set — cannot auto-refresh");
        }
      }
    }

    // Recalcular expires_soon após possível refresh
    const finalExpiresAt = currentExpiresAt ? new Date(currentExpiresAt) : null;
    const finalExpiresSoon = finalExpiresAt && (finalExpiresAt.getTime() - now.getTime()) < sevenDaysMs;

    console.log("[meta-status] Token valid. Expires:", currentExpiresAt, "expiresSoon:", finalExpiresSoon, "refreshed:", refreshed);

    return new Response(JSON.stringify({
      connected: true,
      access_token: currentToken,
      meta_name: metaName,
      expires_at: currentExpiresAt,
      expires_soon: finalExpiresSoon || false,
      refreshed,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[meta-status] Error:", e.message);
    return new Response(JSON.stringify({ error: e.message, connected: false }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
