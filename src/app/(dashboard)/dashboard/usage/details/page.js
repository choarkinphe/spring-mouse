import { Suspense } from "react";
import UsageDetailsClient from "./UsageDetailsClient";

export default function UsageDetailsPage() {
  return (
    <Suspense fallback={<div className="rounded-xl border border-border bg-surface px-5 py-12 text-center text-sm text-text-muted">正在加载使用明细…</div>}>
      <UsageDetailsClient />
    </Suspense>
  );
}
