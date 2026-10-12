"use client";

import { useEffect, useState } from "react";
import { AccessTagsEditor, Button, Card } from "@/shared/components";
import { normalizeAccessTags } from "@/shared/utils/accessTags";

export default function SystemoneAccessCard() {
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("读取调用权限失败");
        const data = await response.json();
        if (!cancelled) {
          setTags(normalizeAccessTags(data.systemoneAccessTags));
          setLoading(false);
        }
      })
      .catch((failure) => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemoneAccessTags: tags }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存调用权限失败");
      setTags(normalizeAccessTags(data.systemoneAccessTags));
      setSaved(true);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <h3 className="mb-2 text-lg font-semibold">JevAPI 调用权限</h3>
      <p className="mb-4 text-xs leading-5 text-text-muted">
        限制 /v1/systemone 的全部模型和账号。请在「集成与凭据」中给 Spring Mouse API Key 分配对应的权限标签；请求正文或请求头中自行声明的标签不生效。
      </p>
      {loading ? <p className="text-sm text-text-muted">{error || "正在读取调用权限…"}</p> : (
        <fieldset disabled={saving}>
          <AccessTagsEditor
            label="允许调用的 Key 权限标签"
            hint="命中任意一个标签即可调用；无标签或不匹配的 Key 返回 403。不填写则不增加接口级限制，仍执行现有鉴权、额度和模型权限。"
            value={tags}
            onChange={(value) => { setTags(value); setSaved(false); }}
          />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={save} disabled={saving}>{saving ? "保存中…" : "保存调用权限"}</Button>
            {saved && <span role="status" className="text-sm text-green-600">调用权限已保存</span>}
            {error && <span role="alert" className="text-sm text-red-500">{error}</span>}
          </div>
        </fieldset>
      )}
    </Card>
  );
}
