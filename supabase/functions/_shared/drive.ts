// Helpers de Google Drive compartilhados entre meta-publish e meta-validate-creative.
// Extração de fileId e URL de download ficam num só lugar pra validate continuar
// espelhando exatamente o caminho que o publish usa (ver CLAUDE.md).

export function extractDriveFileId(driveLink: string): string | undefined {
  const match = driveLink.match(/\/d\/([a-zA-Z0-9_-]+)/) || driveLink.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match?.[1];
}

export function buildDriveApiUrl(fileId: string, apiKey: string): string {
  // acknowledgeAbuse=true: parâmetro oficial da Drive API v3 pra baixar mesmo quando o
  // Google mostra "não consigo escanear esse arquivo por vírus" (sempre acontece em
  // arquivos grandes, ~200MB+ — não é malware, é só tamanho). Sem isso a chave de API
  // (sem sessão de navegador pra clicar "Download mesmo assim") trava sem alternativa —
  // via=key não tem o fluxo confirm=t/uuid que o link anônimo do navegador tem.
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&acknowledgeAbuse=true&key=${apiKey}`;
}
