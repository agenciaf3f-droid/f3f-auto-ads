import { createContext, useContext, useEffect, useState, ReactNode } from "react";

// Sinal GLOBAL de "publicação em andamento". Vive no AppLayout (NÃO desmonta ao trocar de aba),
// então sobrevive mesmo quando o PublishForm (que é uma rota) é desmontado. Usado por:
//  - PublishForm: seta true/false ao redor do handlePublish.
//  - AppSidebar: confirma antes de navegar (senão o loop de publish continua invisível → desync).
//  - Este provider: beforeunload avisa ao fechar/recarregar a aba durante o publish.
interface PublishingContextType {
  publishing: boolean;
  setPublishing: (v: boolean) => void;
}

const PublishingContext = createContext<PublishingContextType>({ publishing: false, setPublishing: () => {} });

export const usePublishing = () => useContext(PublishingContext);

export function PublishingProvider({ children }: { children: ReactNode }) {
  const [publishing, setPublishing] = useState(false);

  // Enquanto publica: avisa ao FECHAR/RECARREGAR a aba (o loop de publish roda no navegador —
  // fechar/reload mata o acompanhamento). O listener some quando não está publicando.
  useEffect(() => {
    if (!publishing) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // exigido por alguns navegadores pra disparar o diálogo nativo
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [publishing]);

  return (
    <PublishingContext.Provider value={{ publishing, setPublishing }}>
      {children}
    </PublishingContext.Provider>
  );
}
