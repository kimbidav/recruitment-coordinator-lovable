export const ASHBY_AUTOMATION_API_BASE =
  import.meta.env.VITE_ASHBY_AUTOMATION_API_BASE ||
  "https://ashby-automation-production.up.railway.app";

export async function readErrorPayload(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) {
      const data = await res.json();
      if (typeof data?.error === "string" && data.error.trim()) return data.error;
      if (typeof data?.message === "string" && data.message.trim()) return data.message;
      return `Request failed (${res.status})`;
    }

    const text = await res.text();
    return text.trim() || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}
