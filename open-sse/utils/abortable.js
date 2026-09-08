export function combineWithTimeout(signal, timeoutMs) {
  const timeoutSignal = Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortSignal?.timeout === "function"
    ? AbortSignal.timeout(timeoutMs)
    : null;
  if (signal && timeoutSignal && typeof AbortSignal?.any === "function") {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  return signal || timeoutSignal || undefined;
}

function abortError(reason) {
  const message = reason instanceof Error ? reason.message : (reason ? String(reason) : "The operation was aborted");
  const error = new Error(message, reason instanceof Error ? { cause: reason } : undefined);
  error.name = "AbortError";
  return error;
}

function timeoutError(message) {
  const error = new Error(message || "The operation timed out");
  error.name = "TimeoutError";
  return error;
}

/**
 * Run an async operation with both caller cancellation and an explicit deadline.
 * `onTimeout` must abort/destroy the underlying I/O; the race alone only releases
 * the caller and cannot reclaim a socket owned by the operation.
 */
export function runWithAbortDeadline(operation, {
  signal,
  timeoutMs,
  timeoutMessage = "The operation timed out",
  onTimeout,
} = {}) {
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener("abort", handleAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const handleAbort = () => finish(reject, abortError(signal?.reason));

    signal?.addEventListener("abort", handleAbort, { once: true });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const error = timeoutError(timeoutMessage);
        try { onTimeout?.(error); } catch { /* cleanup is best-effort */ }
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    }

    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
  });
}
