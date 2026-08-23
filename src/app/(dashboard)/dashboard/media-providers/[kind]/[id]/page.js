"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

export default function MediaProviderDetailPage() {
  const { kind, id } = useParams();
  const router = useRouter();

  useEffect(() => {
    if (!kind || !id) return;
    router.replace(`/dashboard/media-providers?kind=${encodeURIComponent(kind)}&provider=${encodeURIComponent(id)}`);
  }, [id, kind, router]);

  return <div className="py-12 text-center text-sm text-text-muted">正在打开服务商配置…</div>;
}
