// Bridge between the Compass page and the extension. The page posts
// `compass-request-ashby-cookie`; we answer with `compass-ashby-cookie`.
// Only same-window messages are honored, and the answer only goes back to
// the page that asked (window.postMessage with the page's own origin).
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== "compass-request-ashby-cookie") return;
  chrome.runtime.sendMessage({ type: "compass-get-ashby-cookie" }, (res) => {
    window.postMessage({ type: "compass-ashby-cookie", ok: !!res?.ok, value: res?.value ?? null, requestId: event.data.requestId }, window.location.origin);
  });
});
// Let the page know the extension is present.
window.postMessage({ type: "compass-extension-ready" }, window.location.origin);
