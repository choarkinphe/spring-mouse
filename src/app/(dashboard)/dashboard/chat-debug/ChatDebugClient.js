"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { useNotificationStore } from "@/store/notificationStore";
import Composer from "./components/Composer.js";
import MessageList from "./components/MessageList.js";
import MetricsPanel from "./components/MetricsPanel.js";
import ModelPicker from "./components/ModelPicker.js";
import {
  MAX_ATTACHMENTS_PER_TURN,
  MODEL_STORAGE_KEY,
  PROVISION_KEY_NAME,
  buildUserContent,
  comboMemberModel,
  computeRunStats,
  createId,
  extractUsage,
  fileToDataUrl,
  loadHistory,
  readDelta,
  sampleTimeline,
  saveHistory,
  textValue,
} from "./chatDebugLib.js";

// Mirror of EndpointPageClient's auto-provisioning: reuse the first active key,
// or create one dedicated to this tool. The key lives in React state only.
async function ensureApiKey() {
  const fetchKeys = async () => {
    const res = await fetch("/api/keys", { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return data.keys || [];
  };

  let keys = await fetchKeys();
  if (keys.length === 0) {
    const createRes = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: PROVISION_KEY_NAME }),
    });
    if (createRes.ok) keys = await fetchKeys();
  }

  const usable = keys.find((key) => key.isActive !== false && key.key);
  if (!usable) throw new Error("没有可用的 API 密钥");
  return usable.key;
}

// Best-effort server-side view: requestDetails writes are batched (~5s flush),
// so query a little after completion and match by time window (+ model suffix
// when a member model was selected). Purely informational when it misses.
function scheduleServerReconciliation(setLiveRun, selectedModel, t0Wall, totalMs) {
  setTimeout(async () => {
    try {
      const endIso = new Date(new Date(t0Wall).getTime() + totalMs + 5000).toISOString();
      const query = `startDate=${encodeURIComponent(t0Wall)}&endDate=${encodeURIComponent(endIso)}&pageSize=10`;
      const res = await fetch(`/api/usage/request-details?${query}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const bareId = selectedModel.includes("/") ? selectedModel.split("/").pop() : "";
      const hit = (data.details || []).find((detail) => {
        const inWindow = detail.timestamp >= t0Wall && detail.timestamp <= endIso;
        const modelOk = bareId ? String(detail.model || "").includes(bareId) : true;
        return inWindow && modelOk;
      });
      if (hit) {
        setLiveRun((prev) => (prev ? {
          ...prev,
          server: {
            ttft: hit.latency?.ttft,
            total: hit.latency?.total,
            connectionId: hit.connectionId,
          },
        } : prev));
      }
    } catch {
      // Observability may be disabled or the query may race — ignore.
    }
  }, 6000);
}

export default function ChatDebugClient() {
  const notification = useNotificationStore();
  const { getCaps } = useModelCaps();

  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState("loading");
  const [combos, setCombos] = useState([]);
  const [combosLoading, setCombosLoading] = useState(true);
  const [selectedModel, setSelectedModel] = useState("");
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [liveRun, setLiveRun] = useState(null);
  const [history, setHistory] = useState([]);

  const abortRef = useRef(null);
  const streamRef = useRef({ content: "", reasoning: "" });
  const rafRef = useRef(null);
  const chunkTimesRef = useRef([]);
  const ttftRef = useRef(null);
  const usageRef = useRef(null);

  // --- bootstrap: persisted model + history, API key, combos ---
  useEffect(() => {
    let alive = true;
    (async () => {
      // Hydrate localStorage state after the synchronous effect body so we do
      // not cascade renders (react-hooks/set-state-in-effect).
      await Promise.resolve();
      if (!alive) return;
      try {
        const savedModel = globalThis.localStorage.getItem(MODEL_STORAGE_KEY);
        if (savedModel) setSelectedModel(savedModel);
      } catch { /* ignore */ }
      setHistory(loadHistory());

      const [keyResult, combosResult] = await Promise.allSettled([
        ensureApiKey(),
        fetch("/api/combos", { cache: "no-store" }).then((res) => (res.ok ? res.json() : { combos: [] })),
      ]);
      if (!alive) return;

      if (keyResult.status === "fulfilled") {
        setApiKey(keyResult.value);
        setKeyStatus("ready");
      } else {
        setKeyStatus("error");
        notification.error("无法获取 API 密钥，请到「集成与凭据」检查后重试", "对话调试");
      }
      setCombos(combosResult.status === "fulfilled" ? combosResult.value.combos || [] : []);
      setCombosLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notification is a stable zustand store
  }, []);

  useEffect(() => {
    const handleBeforeUnload = () => abortRef.current?.abort();
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      abortRef.current?.abort();
    };
  }, []);

  const handleSelectModel = useCallback((model) => {
    setSelectedModel(model);
    try {
      globalThis.localStorage.setItem(MODEL_STORAGE_KEY, model);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    saveHistory(history);
  }, [history]);

  // Vision support of the current target: combos declare it, members resolve
  // through the capability registry.
  const visionOk = useMemo(() => {
    if (!selectedModel) return false;
    const combo = combos.find((c) => c && c.name === selectedModel);
    if (combo) return combo.capabilities?.vision === true;
    const caps = getCaps(selectedModel);
    return caps?.vision === true;
  }, [selectedModel, combos, getCaps]);

  const activeLlmComboCount = useMemo(
    () => combos.filter((c) => c && c.kind !== "webSearch" && c.kind !== "webFetch" && c.isActive !== false).length,
    [combos],
  );

  const canSend = !isStreaming
    && keyStatus === "ready"
    && !!selectedModel
    && activeLlmComboCount > 0
    && (draft.trim().length > 0 || attachments.length > 0);

  const handleAttachFiles = useCallback(async (files) => {
    const images = Array.from(files || []).filter((file) => file.type && file.type.startsWith("image/"));
    if (images.length === 0) return;
    setAttachments((prev) => {
      const room = MAX_ATTACHMENTS_PER_TURN - prev.length;
      if (room <= 0) {
        notification.warning(`每条消息最多 ${MAX_ATTACHMENTS_PER_TURN} 张图片`, "对话调试");
        return prev;
      }
      if (images.length > room) notification.warning(`每条消息最多 ${MAX_ATTACHMENTS_PER_TURN} 张图片，已忽略多余部分`, "对话调试");
      return [...prev, ...images.slice(0, room).map((file) => ({
        id: createId(),
        name: file.name || "image",
        type: file.type,
        file,
        dataUrl: "",
      }))];
    });
  }, [notification]);

  // Convert staged Files to data URLs as they arrive.
  useEffect(() => {
    let alive = true;
    const pending = attachments.filter((attachment) => attachment.file && !attachment.dataUrl);
    if (pending.length === 0) return undefined;
    (async () => {
      for (const attachment of pending) {
        try {
          const dataUrl = await fileToDataUrl(attachment.file);
          if (!alive) return;
          setAttachments((prev) => prev.map((item) => (item.id === attachment.id ? { ...item, dataUrl, file: null } : item)));
        } catch {
          if (!alive) return;
          setAttachments((prev) => prev.filter((item) => item.id !== attachment.id));
        }
      }
    })();
    return () => { alive = false; };
  }, [attachments]);

  const handleRemoveAttachment = useCallback((attachmentId) => {
    setAttachments((prev) => prev.filter((item) => item.id !== attachmentId));
  }, []);

  const handlePaste = useCallback((event) => {
    if (!visionOk) return;
    const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type && file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    handleAttachFiles(files);
  }, [visionOk, handleAttachFiles]);

  const handleNewSession = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
  }, []);

  const sendMessage = useCallback(async () => {
    if (isStreaming || !selectedModel) return;
    const userText = draft.trim();
    if (!userText && attachments.length === 0) return;

    let activeKey = apiKey;
    if (keyStatus !== "ready" || !activeKey) {
      try {
        activeKey = await ensureApiKey();
        setApiKey(activeKey);
        setKeyStatus("ready");
      } catch {
        setKeyStatus("error");
        notification.error("API 密钥未就绪，请到「集成与凭据」检查", "对话调试");
        return;
      }
    }

    const userMessage = {
      id: createId(),
      role: "user",
      content: userText,
      attachments: attachments.map(({ id, name, type, dataUrl }) => ({ id, name, type, dataUrl })),
      createdAt: new Date().toISOString(),
    };
    const assistantId = createId();
    const assistantMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      reasoning: "",
      status: "streaming",
      createdAt: new Date().toISOString(),
    };

    const historyMessages = messages
      .filter((message) => message.status !== "error")
      .map((message) => ({
        role: message.role,
        content: message.role === "user" ? buildUserContent(message.content, message.attachments) : message.content,
      }));
    historyMessages.push({ role: "user", content: buildUserContent(userText, userMessage.attachments) });

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setDraft("");
    setAttachments([]);

    streamRef.current = { content: "", reasoning: "" };
    chunkTimesRef.current = [];
    ttftRef.current = null;
    usageRef.current = null;

    const t0 = performance.now();
    const t0Wall = new Date().toISOString();
    setLiveRun({
      phase: "waiting",
      model: selectedModel,
      startedAtWall: t0Wall,
      startedAtPerf: t0,
      chunks: 0,
      ttft: null,
      total: null,
      server: null,
    });

    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setIsStreaming(true);

    const flush = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setMessages((prev) => prev.map((message) => (message.id === assistantId ? {
          ...message,
          content: streamRef.current.content,
          reasoning: streamRef.current.reasoning,
        } : message)));
        setLiveRun((prev) => (prev ? { ...prev, chunks: chunkTimesRef.current.length } : prev));
      });
    };

    const finalize = (status, errorMessage = null, httpStatus = null) => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const totalMs = performance.now() - t0;
      setMessages((prev) => prev.map((message) => (message.id === assistantId ? {
        ...message,
        content: streamRef.current.content,
        reasoning: streamRef.current.reasoning,
        status: status === "done" ? "done" : status,
        error: errorMessage,
      } : message)));

      const stats = computeRunStats({
        ttft: ttftRef.current,
        totalMs,
        chunkTimes: chunkTimesRef.current,
        usage: usageRef.current,
        textLen: streamRef.current.content.length,
      });
      const timeline = sampleTimeline(chunkTimesRef.current, t0);
      setLiveRun((prev) => ({
        ...prev,
        phase: status,
        ...stats,
        timeline,
        error: errorMessage,
        httpStatus,
      }));
      if (status === "done") {
        scheduleServerReconciliation(setLiveRun, selectedModel, t0Wall, totalMs);
      }
      setHistory((prev) => [{
        id: createId(),
        time: t0Wall,
        model: selectedModel,
        status,
        error: errorMessage,
        httpStatus,
        ...stats,
        timeline,
      }, ...prev].slice(0, 50));
    };

    try {
      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${activeKey}`,
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: historyMessages,
          stream: true,
        }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const message = textValue(errorData.error || errorData.message) || `请求失败 (${response.status})`;
        throw Object.assign(new Error(message), { status: response.status });
      }

      const reader = response.body?.getReader();
      if (!reader) {
        // Upstream ignored stream:true and returned a plain JSON body.
        const data = await response.json().catch(() => ({}));
        chunkTimesRef.current.push(performance.now());
        const usage = extractUsage(data);
        if (usage) usageRef.current = usage;
        const { content, reasoning } = readDelta(data);
        if (content || reasoning) {
          ttftRef.current = performance.now() - t0;
          streamRef.current.content += content;
          streamRef.current.reasoning += reasoning;
        }
        finalize("done");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const now = performance.now();
        chunkTimesRef.current.push(now);

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let chunk;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }

          const usage = extractUsage(chunk);
          if (usage) usageRef.current = usage;

          const { content, reasoning } = readDelta(chunk);
          if ((content || reasoning) && ttftRef.current == null) {
            ttftRef.current = now - t0;
            setLiveRun((prev) => (prev ? { ...prev, phase: "streaming", ttft: Math.round(ttftRef.current) } : prev));
          }
          if (content) streamRef.current.content += content;
          if (reasoning) streamRef.current.reasoning += reasoning;
          if (content || reasoning) flush();
        }
      }
      finalize("done");
    } catch (error) {
      if (error?.name === "AbortError") {
        finalize("aborted");
      } else {
        const message = textValue(error?.message) || "请求失败";
        const status = Number.isFinite(error?.status) ? error.status : null;
        finalize("error", status ? `HTTP ${status}: ${message}` : message, status);
        notification.error(message, "对话调试");
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [isStreaming, selectedModel, draft, attachments, apiKey, keyStatus, messages, notification]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleClearHistory = useCallback(() => {
    setHistory([]);
  }, []);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-360 gap-0">
      {/* Codex-style chat column: narrow, centered, composer pinned to bottom */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col px-4 lg:px-6">
        <div className="mx-auto flex h-full min-h-0 w-full max-w-250 flex-col">
          <MessageList messages={messages} streamingId={isStreaming ? "live" : null} />
          {keyStatus === "error" ? (
            <div className="shrink-0 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
              无法获取 API 密钥：远程访问 /v1 需要密钥，请到「集成与凭据」创建后刷新本页。
            </div>
          ) : null}
          <Composer
            draft={draft}
            onDraftChange={setDraft}
            attachments={attachments}
            onRemoveAttachment={handleRemoveAttachment}
            visionOk={visionOk}
            isStreaming={isStreaming}
            canSend={canSend}
            onSend={sendMessage}
            onStop={handleStop}
            onAttachFiles={handleAttachFiles}
            onPaste={handlePaste}
            modelSlot={(
              <ModelPicker combos={combos} loading={combosLoading} value={selectedModel} onChange={handleSelectModel} getCaps={getCaps} />
            )}
          />
        </div>
      </div>

      {/* Codex-style detail rail: rounded bordered panel beside the chat */}
      <aside className="hidden min-h-0 shrink-0 overflow-hidden rounded-2xl border border-border bg-surface xl:block xl:w-94 xl:m-2">
        <MetricsPanel liveRun={liveRun} history={history} onClearHistory={handleClearHistory} onNewSession={handleNewSession} keyStatus={keyStatus} />
      </aside>
    </div>
  );
}
