// interceptor.js - Injected into the page's MAIN world to capture x-server-id
// from /_server requests (the content script's isolated world cannot override window.fetch).
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

  window.fetch = function (...args) {
    const url = args[0];
    const options = args[1];

    if (
      typeof url === "string" &&
      url.includes("/_server") &&
      options &&
      options.headers
    ) {
      // Adopt IDs only from the usage-table server function (server-fn:1):
      // other instances' IDs fail those calls with a Flight error payload.
      const instance = findHeader(options.headers, "x-server-instance");
      if (!instance || instance === "server-fn:1") {
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
      }
    }
    return originalFetch.apply(this, args);
  };
})();
