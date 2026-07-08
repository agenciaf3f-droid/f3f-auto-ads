// Guarda anti-SSRF para links de download do Google Drive.
//
// As edge functions rodam com verify_jwt=false (config.toml) — qualquer um pode POSTar
// um corpo arbitrário. Sem esta allow-list, um `creative_link`/`driveLink` apontando pra
// um host interno (169.254.169.254 metadata, 127.0.0.1, etc.) faria a edge fazer fetch
// dele em nome do atacante (SSRF). O gate REAL é o match EXATO de host contra a allow-list;
// a checagem de IP privado é defesa extra (belt-and-suspenders).

// Hosts EXATOS permitidos — cobrem todo o fluxo real de Drive:
//  - drive.google.com            → /file/d/ID/view, /uc?export=download
//  - docs.google.com             → links de Docs/planilhas exportados
//  - drive.usercontent.google.com→ /download?id=... (retry com confirm token)
//  - www.googleapis.com          → Drive API v3 (alt=media&key=)  [buildDriveApiUrl]
//  - drive.googleapis.com        → variante da Drive API
//  - lh3.googleusercontent.com   → CDN de imagem do Drive
const ALLOWED_DRIVE_HOSTS = new Set([
  "drive.google.com",
  "docs.google.com",
  "drive.usercontent.google.com",
  "www.googleapis.com",
  "drive.googleapis.com",
  "lh3.googleusercontent.com",
]);

// IP literal privado/loopback/link-local. Bloqueado mesmo que (por engano) entre na
// allow-list — a allow-list de hosts já barra isso, mas mantemos por robustez.
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (
    h.startsWith("127.") ||
    h.startsWith("10.") ||
    h.startsWith("192.168.") ||
    h.startsWith("169.254.")
  ) return true;
  // 172.16.0.0 – 172.31.255.255
  const m = h.match(/^172\.(\d{1,3})\./);
  if (m) {
    const octet = Number(m[1]);
    if (octet >= 16 && octet <= 31) return true;
  }
  return false;
}

// Retorna { ok:true } só para https + host na allow-list de Drive. Caso contrário
// { ok:false, error } com mensagem pronta pra devolver ao usuário. NÃO faz fetch.
export function assertSafeDriveUrl(url: string): { ok: true } | { ok: false; error: string } {
  const INVALID = { ok: false as const, error: "Link inválido — use um link do Google Drive." };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return INVALID;
  }
  if (parsed.protocol !== "https:") return INVALID;
  const host = parsed.hostname.toLowerCase();
  if (isPrivateHost(host)) return INVALID;
  if (!ALLOWED_DRIVE_HOSTS.has(host)) return INVALID;
  return { ok: true };
}
