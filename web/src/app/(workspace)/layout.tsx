import { WorkspaceProvider } from "@/lib/use-workspace";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return <WorkspaceProvider><WorkspaceShell>{children}</WorkspaceShell></WorkspaceProvider>;
}
