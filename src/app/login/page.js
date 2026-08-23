"use client";

import { useEffect, useState } from "react";
import { Button, Card, Input } from "@/shared/components";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [resetHint, setResetHint] = useState("");
  const [retryAfter, setRetryAfter] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasPassword, setHasPassword] = useState(null);
  const [mustChange, setMustChange] = useState(false);
  const [requiresTotp, setRequiresTotp] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  useEffect(() => {
    if (retryAfter <= 0) return undefined;
    const id = setInterval(() => setRetryAfter((seconds) => (seconds > 0 ? seconds - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [retryAfter]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    fetch("/api/auth/status", { signal: controller.signal })
      .then(async (res) => ({ ok: res.ok, data: res.ok ? await res.json() : null }))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (ok && (data.authenticated === true || data.requireLogin === false)) {
          window.location.assign("/dashboard");
          return;
        }
        setHasPassword(ok ? Boolean(data?.hasPassword) : true);
      })
      .catch(() => {
        if (!cancelled) setHasPassword(true);
      })
      .finally(() => clearTimeout(timeoutId));

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timeoutId);
    };
  }, []);

  const handleLogin = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    setResetHint("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.mustChangePassword) {
          setMustChange(true);
          return;
        }
        if (data.requiresTotp) {
          setRequiresTotp(true);
          setPassword("");
          return;
        }
        window.location.assign("/dashboard");
        return;
      }
      setError(data.error || "Invalid password");
      if (data.resetHint) setResetHint(data.resetHint);
      if (data.retryAfter) setRetryAfter(Number(data.retryAfter));
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleTotpVerify = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/totp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: totpCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Invalid verification code");
        if (data.retryAfter) setRetryAfter(Number(data.retryAfter));
        return;
      }
      window.location.assign("/dashboard");
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleSetNewPassword = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: password, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to set password");
        return;
      }
      window.location.assign("/dashboard");
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (hasPassword === null) {
    return <div className="min-h-screen flex items-center justify-center bg-bg p-4 text-text-muted">Loading…</div>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-primary mb-2">Spring Mouse</h1>
          <p className="text-text-muted">Enter your password to access the dashboard</p>
        </div>
        <Card className="p-6">
          {mustChange ? (
            <form onSubmit={handleSetNewPassword} className="flex flex-col gap-4">
              <div>
                <h2 className="text-lg font-semibold">Set a secure password</h2>
                <p className="text-sm text-text-muted mt-1">A new password is required before remote access is allowed.</p>
              </div>
              <Input type="password" placeholder="New password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required autoFocus />
              {error && <p className="text-xs text-red-500">{error}</p>}
              <Button type="submit" variant="primary" loading={loading} disabled={!newPassword}>Set password</Button>
            </form>
          ) : requiresTotp ? (
            <form onSubmit={handleTotpVerify} className="flex flex-col gap-4">
              <div>
                <h2 className="text-lg font-semibold">Two-factor authentication</h2>
                <p className="mt-1 text-sm text-text-muted">Enter the 6-digit code from Microsoft Authenticator, or a recovery code.</p>
              </div>
              <Input
                placeholder="123456 or ABCDE-12345"
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value.toUpperCase())}
                required
                autoFocus
              />
              {error && <p className="text-xs text-red-500">{error}</p>}
              {retryAfter > 0 && <p className="text-xs text-amber-600 dark:text-amber-400">Locked. Retry in <span className="font-mono">{retryAfter}s</span>.</p>}
              <Button type="submit" variant="primary" loading={loading} disabled={retryAfter > 0}>Verify and sign in</Button>
              <button type="button" className="text-xs text-text-muted hover:text-text-main" onClick={() => { setRequiresTotp(false); setTotpCode(""); setError(""); }}>
                Back to password sign-in
              </button>
            </form>
          ) : (
            <form onSubmit={handleLogin} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Password</label>
                <Input type="password" placeholder="Enter password" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus />
              </div>
              {error && <p className="text-xs text-red-500">{error}</p>}
              {retryAfter > 0 && <p className="text-xs text-amber-600 dark:text-amber-400">Locked. Retry in <span className="font-mono">{retryAfter}s</span>.</p>}
              {resetHint && <p className="text-xs text-text-muted">{resetHint}</p>}
              {!hasPassword && <p className="text-xs text-amber-600 dark:text-amber-400">Use the initial password to sign in, then set a new password in Settings.</p>}
              <Button type="submit" variant="primary" loading={loading} disabled={retryAfter > 0}>Sign in</Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
