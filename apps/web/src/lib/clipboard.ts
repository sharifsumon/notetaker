/**
 * Copies plain text to the clipboard (FR-12). Uses the async Clipboard API and falls back
 * to a hidden textarea + execCommand for browsers/contexts where the API is unavailable.
 * Returns false when the browser refuses both, so the UI can show an actionable error.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or insecure context: try the legacy path below.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === "function" && document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
