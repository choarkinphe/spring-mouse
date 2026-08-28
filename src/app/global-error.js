"use client";

import { useEffect, useState } from "react";

const AUTO_RELOAD_KEY = "spring-mouse:global-error-auto-reload";
const AUTO_RELOAD_WINDOW_MS = 30_000;

const styles = {
  body: {
    margin: 0,
    color: "#171717",
    background: "#ffffff",
  },
  container: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    boxSizing: "border-box",
    fontFamily: 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  card: {
    width: "100%",
    maxWidth: "420px",
    padding: "32px 28px",
    border: "1px solid rgba(0, 0, 0, 0.08)",
    borderRadius: "16px",
    boxShadow: "0 18px 50px rgba(0, 0, 0, 0.08)",
  },
  icon: {
    width: "42px",
    height: "42px",
    display: "grid",
    placeItems: "center",
    marginBottom: "20px",
    borderRadius: "12px",
    color: "#b45309",
    background: "#fffbeb",
    fontSize: "24px",
    fontWeight: 700,
  },
  title: {
    margin: "0 0 10px",
    fontSize: "24px",
    lineHeight: 1.3,
    fontWeight: 650,
    letterSpacing: "-0.02em",
  },
  message: {
    margin: "0 0 22px",
    color: "#525252",
    fontSize: "14px",
    lineHeight: 1.6,
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "10px",
  },
  primaryButton: {
    height: "38px",
    padding: "0 16px",
    border: 0,
    borderRadius: "8px",
    color: "#ffffff",
    background: "#171717",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 600,
  },
  secondaryButton: {
    height: "38px",
    padding: "0 16px",
    border: "1px solid rgba(0, 0, 0, 0.1)",
    borderRadius: "8px",
    color: "#171717",
    background: "transparent",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 600,
  },
  digest: {
    margin: "18px 0 0",
    color: "#737373",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "11px",
    overflowWrap: "anywhere",
  },
};

function reserveAutoReload() {
  const now = Date.now();
  const url = window.location.href;

  try {
    const previous = JSON.parse(window.sessionStorage.getItem(AUTO_RELOAD_KEY) || "null");
    const recentlyRetried = previous?.url === url
      && Number.isFinite(previous?.timestamp)
      && now - previous.timestamp < AUTO_RELOAD_WINDOW_MS;

    if (recentlyRetried) return false;

    window.sessionStorage.setItem(AUTO_RELOAD_KEY, JSON.stringify({ url, timestamp: now }));
    return true;
  } catch {
    // Without sessionStorage we cannot prevent a permanent reload loop safely.
    return false;
  }
}

export default function GlobalError({ error }) {
  const [autoReloading, setAutoReloading] = useState(true);

  useEffect(() => {
    console.error("[GlobalError] Uncaught page failure", error);

    if (!reserveAutoReload()) {
      const fallbackTimer = window.setTimeout(() => setAutoReloading(false), 0);
      return () => window.clearTimeout(fallbackTimer);
    }

    const timer = window.setTimeout(() => window.location.reload(), 350);
    return () => window.clearTimeout(timer);
  }, [error]);

  const goBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = "/";
    }
  };

  return (
    <html id="__next_error__" lang="zh-CN">
      <head>
        <title>页面加载失败 - Spring Mouse</title>
        <meta name="color-scheme" content="light dark" />
        <style>{`
          @media (prefers-color-scheme: dark) {
            body { color: #ededed !important; background: #0a0a0a !important; }
            #spring-mouse-error-card { border-color: rgba(255,255,255,.14) !important; box-shadow: 0 18px 50px rgba(0,0,0,.35) !important; }
            #spring-mouse-error-message, #spring-mouse-error-digest { color: #a3a3a3 !important; }
            #spring-mouse-error-back { color: #ededed !important; border-color: rgba(255,255,255,.16) !important; }
            #spring-mouse-error-reload { color: #0a0a0a !important; background: #ededed !important; }
            #spring-mouse-error-icon { color: #fbbf24 !important; background: rgba(245,158,11,.12) !important; }
          }
        `}</style>
      </head>
      <body style={styles.body}>
        <main style={styles.container}>
          <section id="spring-mouse-error-card" style={styles.card} aria-live="assertive">
            <div id="spring-mouse-error-icon" style={styles.icon} aria-hidden="true">!</div>
            <h1 style={styles.title}>{autoReloading ? "正在恢复页面" : "页面暂时无法加载"}</h1>
            <p id="spring-mouse-error-message" style={styles.message}>
              {autoReloading
                ? "检测到临时加载异常，正在自动重新载入一次…"
                : "自动恢复没有成功。你可以重新载入页面，或返回上一页继续操作。"}
            </p>
            {!autoReloading ? (
              <div style={styles.actions}>
                <button
                  id="spring-mouse-error-reload"
                  type="button"
                  style={styles.primaryButton}
                  onClick={() => window.location.reload()}
                >
                  重新载入
                </button>
                <button
                  id="spring-mouse-error-back"
                  type="button"
                  style={styles.secondaryButton}
                  onClick={goBack}
                >
                  返回上一页
                </button>
              </div>
            ) : null}
            {error?.digest ? (
              <p id="spring-mouse-error-digest" style={styles.digest}>错误标识：{error.digest}</p>
            ) : null}
          </section>
        </main>
      </body>
    </html>
  );
}
