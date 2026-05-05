import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req) => {
  const appId = "910343951738258";
  const redirectUri = "https://f3f-auto-ads.vercel.app/auth/meta/callback";
  const scopes = "ads_management,ads_read,business_management,pages_show_list,pages_read_engagement,instagram_basic";
  const state = crypto.randomUUID();

  const url = `https://www.facebook.com/v22.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&response_type=code&state=${state}`;

  return new Response(null, {
    status: 302,
    headers: { Location: url },
  });
});
