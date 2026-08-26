/** Cursor API key validation shared by the chat and console UIs. */

// Cursor keys are opaque tokens, so shape is all we can check. The case worth
// catching is a masked preview such as "crsr_24ea…" copied out of a UI: it is
// long enough to pass a non-empty check but is always rejected upstream.
const KEY_ALLOWED_PATTERN = /^[A-Za-z0-9_\-.]+$/;
const KEY_MIN_LENGTH = 20;

/** Returns a user-facing reason the key cannot be used, or undefined if it looks usable. */
export function keyRejectionReason(value: string): string | undefined {
  if (!value) return "Enter a Cursor API key to continue.";
  if (value.includes("\u2026") || value.includes("...")) {
    return "That key looks truncated. Paste the full key rather than a masked preview.";
  }
  if (/\s/.test(value)) return "Remove the spaces or line breaks inside the key.";
  if (!KEY_ALLOWED_PATTERN.test(value)) return "That does not look like a Cursor API key.";
  if (value.length < KEY_MIN_LENGTH) return "That key is too short to be a complete Cursor API key.";
  return undefined;
}