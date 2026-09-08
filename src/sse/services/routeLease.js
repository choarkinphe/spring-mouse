/** Hold an account lease across setup, upstream I/O and downstream streaming. */
export async function withRouteLease(releaseSlot, signal, execute) {
  let released = false;
  let reader = null;
  const release = () => {
    if (released) return;
    released = true;
    signal?.removeEventListener("abort", onAbort);
    // Accounting must not delay the last token/EOF or mask an upstream error.
    Promise.resolve().then(() => releaseSlot?.()).catch(() => {});
  };
  const onAbort = () => {
    release();
    if (reader) reader.cancel(signal.reason).catch(() => {});
  };
  if (signal?.aborted) {
    release();
    throw new DOMException("Request aborted", "AbortError");
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await execute();
    if (!result.success || !result.response?.body) {
      release();
      return result;
    }
    const response = result.response;
    reader = response.body.getReader();
    if (signal?.aborted) { onAbort(); throw new DOMException("Request aborted", "AbortError"); }
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { release(); controller.close(); }
          else controller.enqueue(value);
        } catch (error) { release(); controller.error(error); }
      },
      async cancel(reason) {
        release();
        await reader.cancel(reason);
      },
    });
    return { ...result, response: new response.constructor(body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    }) };
  } catch (error) {
    release();
    reader?.cancel(error).catch(() => {});
    throw error;
  }
}
