// Local-only storage for the Ashby session cookie. The cookie is only useful
// from the same browser anyway, and Ashby cookies expire on the order of
// minutes, so persisting server-side adds no value.

const KEY = "ashby_session_cookie";

export function getStoredAshbyCookie(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setStoredAshbyCookie(cookie: string) {
  try {
    localStorage.setItem(KEY, cookie.trim());
  } catch {
    // ignore
  }
}

export function clearStoredAshbyCookie() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
