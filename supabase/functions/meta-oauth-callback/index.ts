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
    const { code, redirect_uri } = await req.json();
    const appId = "910343951738258";
    const appSecret = Deno.env.get("META_APP_SECRET");
    const appUrl = Deno.env.get("APP_URL") ?? "https://f3f-auto-ads-eight.vercel.app";
    const finalRedirectUri = redirect_uri || `${appUrl}/auth/meta/callback`;

    if (!appSecret) {
      return new Response(JSON.stringify({ error: "META_APP_SECRET not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. Exchange code for short-lived token
    console.log("[meta-oauth-callback] Exchanging code for token...");
    const tokenUrl = `https://graph.facebook.com/v22.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(finalRedirectUri)}&client_secret=${appSecret}&code=${code}`;
    const res = await fetch(tokenUrl);
    const data = await res.json();

    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Exchange for long-lived token
    console.log("[meta-oauth-callback] Exchanging for long-lived token...");
    const llUrl = `https://graph.facebook.com/v22.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${data.access_token}`;
    const llRes = await fetch(llUrl);
    const llData = await llRes.json();

    const finalToken = llData.access_token || data.access_token;
    const expiresIn = llData.expires_in || data.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const isLongLived = !!llData.access_token;

    console.log("[meta-oauth-callback] Token obtained:", {
      isLongLived,
      expiresIn,
      expiresAt,
      tokenPrefix: finalToken?.substring(0, 10) + "...",
    });

    // 3. Save to DB if user is authenticated
    let savedToDb = false;
    if (authHeader) {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      );

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        console.log("[meta-oauth-callback] Saving token for user:", user.id);
        // Upsert meta connection
        const { data: existing } = await supabase
          .from("meta_connections")
          .select("id")
          .eq("user_id", user.id)
          .maybeSingle();

        if (existing) {
          const { error: updateErr } = await supabase
            .from("meta_connections")
            .update({ access_token: finalToken, expires_at: expiresAt })
            .eq("id", existing.id);
          savedToDb = !updateErr;
          if (updateErr) console.error("[meta-oauth-callback] Update error:", updateErr);
        } else {
          const { error: insertErr } = await supabase
            .from("meta_connections")
            .insert({ user_id: user.id, access_token: finalToken, expires_at: expiresAt });
          savedToDb = !insertErr;
          if (insertErr) console.error("[meta-oauth-callback] Insert error:", insertErr);
        }
        console.log("[meta-oauth-callback] Token saved to DB:", savedToDb);
      } else {
        console.warn("[meta-oauth-callback] No user found from auth header");
      }
    } else {
      console.warn("[meta-oauth-callback] No auth header - token NOT saved to DB");
    }

    return new Response(JSON.stringify({
      access_token: finalToken,
      expires_in: expiresIn,
      is_long_lived: isLongLived,
      saved_to_db: savedToDb,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
