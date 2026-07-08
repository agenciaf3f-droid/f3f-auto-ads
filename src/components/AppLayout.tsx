import { Outlet } from "react-router-dom";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import AppSidebar from "@/components/AppSidebar";
import AppTopbar from "@/components/AppTopbar";
import { PublishingProvider } from "@/contexts/PublishingContext";

export default function AppLayout() {
  // PublishingProvider AQUI (fora do Outlet) sobrevive à troca de aba → guarda o sinal de
  // publicação em andamento p/ o guard de navegação e o beforeunload.
  return (
    <PublishingProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <AppTopbar />
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </PublishingProvider>
  );
}
