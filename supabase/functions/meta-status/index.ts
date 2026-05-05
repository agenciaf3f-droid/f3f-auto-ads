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

    const { data: conn } = await supabase
      .from("meta_connections")
      .select("access_token, expires_at")
      .eq("user_id", user.id)
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
    if (forceVerify || expiresSoon) {
      console.log("[meta-status] Verifying token with Meta API (force:", forceVerify, ", expiresSoon:", expiresSoon, ")");
      const meRes = await fetch(`https://graph.facebook.com/v22.0/me?fields=name&access_token=${conn.access_token}`);
      const meData = await meRes.json();

      if (meData.error) {
        console.log("[meta-status] Meta API error:", meData.error);
        return new Response(JSON.stringify({ connected: false, reason: "invalid_token", error: meData.error.message }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      metaName = meData.name;
    }

    console.log("[meta-status] Token valid. Expires:", conn.expires_at, "expiresSoon:", expiresSoon);

    return new Response(JSON.stringify({
      connected: true,
      access_token: conn.access_token,
      meta_name: metaName,
      expires_at: conn.expires_at,
      expires_soon: expiresSoon || false,
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
