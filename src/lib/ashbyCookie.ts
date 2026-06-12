// RETIRED: the Ashby session is org-shared and lives on the extraction
// service (seeded via ashby-sync {action:"seed"}), not in the browser.
// Only the cleanup helper remains so old localStorage entries get wiped.

const KEY = "ashby_session_cookie";

export function clearStoredAshbyCookie() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
