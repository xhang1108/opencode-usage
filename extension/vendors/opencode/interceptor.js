// interceptor.js - Injected into the page's MAIN world to capture x-server-id
// and request templates from /_server requests (the content script's isolated
// world cannot override window.fetch).
//
// What counts as a capture source is decided by the REQUEST BODY SHAPE (a
// usage-table list query), never by the `x-server-instance` header: that label
// is an opaque per-request id that opencode's server echoes back unchanged
// (e.g. the usage route currently shows up as server-fn:12..16 and rotates),
// so filtering on it silently stops capturing after every redeploy.
(() => {
  if (window.__opencodeMasterInterceptor) return;
  window.__opencodeMasterInterceptor = true;

  const originalFetch = window.fetch;

  function findHeader(headers, name) {
    const lower = name.toLowerCase();
    if (headers instanceof Headers) {
      return headers.get(lower) || undefined;
    }
    for (const key of Object.keys(headers || {})) {
      if (key.toLowerCase() === lower) return headers[key];
    }
    return undefined;
  }

  // Usage-table list query: { f:number, t:{ ..., a:[{t:1,s:"wrk_..."},{t:0,s:<page>}] } }.
  // The args pair {t:1,s:wrk} = workspace and {t:0,s:number} = page is what the
  // crawler later substitutes, so this shape is both the "is usage" marker and
  // the crawl template source. Instance headers are ignored (echo-only).
  function isUsageListQuery(parsed) {
    if (!parsed || typeof parsed.f !== "number") return false;
    const t = parsed.t;
    if (!t || !Array.isArray(t.a)) return false;
    let hasWs = false;
    let hasPage = false;
    for (const arg of t.a) {
      if (!arg || typeof arg !== "object") continue;
      if (arg.t === 1 && typeof arg.s === "string" && arg.s.indexOf("wrk_") === 0) hasWs = true;
      else if (arg.t === 0 && typeof arg.s === "number") hasPage = true;
    }
    return hasWs && hasPage;
  }

  window.fetch = function (...args) {
    const url = args[0];
    const options = args[1];

    if (
      typeof url === "string" &&
      url.includes("/_server") &&
      options &&
      typeof options.body === "string"
    ) {
      const rawBody = options.body;
      // Parse once; the body is used for both the SID and the template decision.
      let parsed = null;
      if (rawBody.length < 20000 && rawBody.includes('"f"')) {
        try { parsed = JSON.parse(rawBody); } catch (e) { parsed = null; }
      }
      if (parsed && isUsageListQuery(parsed)) {
        const serverID = findHeader(options.headers, "x-server-id");
        if (serverID) {
          try {
            window.postMessage(
              { source: "opencode-master", type: "server-id", serverID },
              "*"
            );
          } catch (e) {
            // Page closed or DOM unavailable
          }
        }
        // Capture the request body as a crawl template: the crawler reuses the
        // observed `f` + `t` shape and only substitutes workspace/page per
        // request.
        try {
          window.postMessage(
            {
              source: "opencode-master",
              type: "server-payload",
              serverID: serverID || null,
              f: parsed.f,
              body: rawBody,
              at: Date.now(),
            },
            "*"
          );
        } catch (e) {
          // Template capture is best-effort; serverID above still counts
        }
      }
    }
    return originalFetch.apply(this, args);
  };
})();
