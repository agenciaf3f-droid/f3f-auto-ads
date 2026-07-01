// Helpers de Google Drive compartilhados entre meta-publish e meta-validate-creative.
// Extração de fileId e URL de download ficam num só lugar pra validate continuar
// espelhando exatamente o caminho que o publish usa (ver CLAUDE.md).

export function extractDriveFileId(driveLink: string): string | undefined {
  const match = driveLink.match(/\/d\/([a-zA-Z0-9_-]+)/) || driveLink.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match?.[1];
}

export function buildDriveApiUrl(fileId: string, apiKey: string): string {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
}
