// Reads the Ashby session cookie on request from the Compass page's content
// script. `ashby_session_token` is HttpOnly, which is why a page (or a
// bookmarklet) cannot read it and an extension with the `cookies` permission
// can. The cookie is handed straight to the page, which sends it to Compass
// under the signed-in recruiter's own session; it is never stored here and
// never leaves the browser any other way.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "compass-get-ashby-cookie") return false;
  chrome.cookies.get({ url: "https://app.ashbyhq.com/", name: "ashby_session_token" }, (cookie) => {
    sendResponse({ ok: !!cookie?.value, value: cookie?.value ?? null });
  });
  return true; // async sendResponse
});
