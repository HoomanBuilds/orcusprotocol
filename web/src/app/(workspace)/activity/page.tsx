import { Suspense } from "react";
import { ActivityWorkspace } from "@/components/workspace/activity-workspace";

export default function ActivityPage() {
  return <Suspense fallback={<div className="workspace-loading" role="status">Loading activity...</div>}><ActivityWorkspace/></Suspense>;
}
