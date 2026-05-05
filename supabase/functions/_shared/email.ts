// Helper de envio de emails via Resend, adaptado de ProcessosF3F (Next.js → Deno).
// Usado pelas edge functions que precisam mandar email transacional.

import { Resend } from "npm:resend@4.0.1";

type EmailConfig =
  | { ok: true; client: Resend; from: string; appUrl: string }
  | { ok: false; reason: string };

function getEmailConfig(): EmailConfig {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("RESEND_FROM_EMAIL");
  const appUrl = Deno.env.get("APP_URL") ?? "https://f3f-auto-ads.vercel.app";
  if (!apiKey) return { ok: false, reason: "RESEND_API_KEY ausente" };
  if (!from) return { ok: false, reason: "RESEND_FROM_EMAIL ausente" };
  return { ok: true, client: new Resend(apiKey), from, appUrl };
}

// ─── Layout base ──────────────────────────────────────────────

function emailWrapper(content: string) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f8f9fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:40px auto;padding:0 20px;">
    <div style="background:#0f1117;border-radius:16px 16px 0 0;padding:24px 32px;display:flex;align-items:center;gap:12px;">
      <div style="width:32px;height:32px;background:#10b981;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;color:white;font-size:15px;">F</div>
      <span style="color:white;font-size:17px;font-weight:700;">F3F AUTO-ADS</span>
    </div>
    ${content}
    <div style="padding:20px 32px;text-align:center;">
      <p style="margin:0;font-size:12px;color:#9ca3af;">F3F AUTO-ADS &middot; Se você não esperava este e-mail, ignore-o.</p>
    </div>
  </div>
</body>
</html>`;
}

function emailBody(inner: string) {
  return `<div style="background:white;padding:32px;border:1px solid #e5e7eb;border-top:none;">${inner}</div>`;
}

function primaryButton(href: string, label: string) {
  return `<a href="${href}" style="display:block;text-align:center;background:#10b981;color:white;font-size:15px;font-weight:600;padding:14px 24px;border-radius:10px;text-decoration:none;margin-top:24px;">${label}</a>`;
}

function infoBox(content: string) {
  return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:20px 24px;margin:20px 0;">${content}</div>`;
}

function warningBox(content: string) {
  return `<div style="font-size:13px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;margin:16px 0;">${content}</div>`;
}

// ─── Invite ───────────────────────────────────────────────────

export async function sendInviteEmail({
  toEmail,
  toName,
  tempPassword,
}: {
  toEmail: string;
  toName: string;
  tempPassword: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const config = getEmailConfig();
  if (!config.ok) {
    console.log(`[email] Invite desativado (${config.reason}) → ${toEmail}`);
    return { ok: false, reason: config.reason };
  }
  const { client, from, appUrl } = config;

  const html = emailWrapper(emailBody(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">Olá, ${toName}!</h1>
    <p style="margin:0 0 24px;color:#6b7280;font-size:15px;line-height:1.6;">
      Você foi convidado para acessar o <strong>F3F AUTO-ADS</strong> — automação de campanhas Meta para gestores de tráfego.
    </p>
    ${infoBox(`
      <p style="margin:0 0 12px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#9ca3af;">Suas credenciais de acesso</p>
      <div>
        <span style="font-size:12px;color:#9ca3af;">E-mail</span>
        <p style="margin:2px 0 10px;font-size:14px;font-weight:600;color:#111827;">${toEmail}</p>
        <span style="font-size:12px;color:#9ca3af;">Senha temporária</span>
        <p style="margin:2px 0 0;font-size:18px;font-weight:700;color:#10b981;font-family:'Courier New',monospace;letter-spacing:0.08em;">${tempPassword}</p>
      </div>
    `)}
    ${warningBox("Recomendamos trocar a senha após o primeiro acesso em &quot;Esqueci minha senha&quot;.")}
    ${primaryButton(appUrl, "Acessar a plataforma")}
  `));

  const { error } = await client.emails.send({
    from,
    to: toEmail,
    subject: "Você foi convidado para o F3F AUTO-ADS",
    html,
  });
  if (error) {
    console.error("[email] Resend error:", error);
    return { ok: false, reason: error.message ?? "Resend send failed" };
  }
  return { ok: true };
}
