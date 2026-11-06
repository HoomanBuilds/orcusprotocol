import { Suspense } from "react";
import { SettingsPage } from "@/components/workspace/workspace-pages";

export default function Page() {
  return <Suspense fallback={<div className="workspace-loading" role="status">Loading settings...</div>}><SettingsPage/></Suspense>;
}
