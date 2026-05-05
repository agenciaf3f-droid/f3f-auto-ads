import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req) => {
  const appId = "910343951738258";
  const appUrl = Deno.env.get("APP_URL") ?? "https://f3f-auto-ads-eight.vercel.app";
  const redirectUri = `${appUrl}/auth/meta/callback`;
  const scopes = "ads_management,ads_read,business_management,pages_show_list,pages_read_engagement,instagram_basic";
  const state = crypto.randomUUID();

  const url = `https://www.facebook.com/v22.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&response_type=code&state=${state}`;

  return new Response(null, {
    status: 302,
    headers: { Location: url },
  });
});
