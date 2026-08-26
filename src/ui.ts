import {
  ArrowRight,
  Check,
  ChevronDown,
  Code2,
  Copy,
  EllipsisVertical,
  Eye,
  ImagePlus,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  Menu,
  MessageSquarePlus,
  Pencil,
  Plus,
  RefreshCw,
  ScrollText,
  SendHorizontal,
  Server,
  Sparkles,
  Terminal,
  Trash2,
  TriangleAlert,
  User,
  X,
  Zap,
  type IconNode
} from "lucide";

/** Lucide icons referenced by name from the console and chat views. */
export const icons = {
  ArrowRight,
  Check,
  ChevronDown,
  Code2,
  Copy,
  EllipsisVertical,
  Eye,
  ImagePlus,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  Menu,
  MessageSquarePlus,
  Pencil,
  Plus,
  RefreshCw,
  ScrollText,
  SendHorizontal,
  Server,
  Sparkles,
  Terminal,
  Trash2,
  TriangleAlert,
  User,
  X,
  Zap
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof icons;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

/** Serialize a Lucide icon node to an inline SVG string. */
export function iconToSvg(icon: IconNode, attrs: Record<string, string | number> = {}): string {
  const attrText = Object.entries({
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    width: 18,
    height: 18,
    "aria-hidden": "true",
    ...attrs
  })
    .map(([key, value]) => `${key}="${escapeAttr(String(value))}"`)
    .join(" ");
  const children = icon
    .map(([tag, childAttrs]) => {
      const childAttrText = Object.entries(childAttrs)
        .map(([key, value]) => `${key}="${escapeAttr(String(value))}"`)
        .join(" ");
      return `<${tag} ${childAttrText}></${tag}>`;
    })
    .join("");
  return `<svg ${attrText}>${children}</svg>`;
}

/** Render an icon by name, falling back to an empty string for unknown names. */
export function icon(name: IconName, attrs: Record<string, string | number> = {}): string {
  return iconToSvg(icons[name], attrs);
}

type QueryRoot = {
  querySelectorAll<E extends Element = Element>(selectors: string): NodeListOf<E>;
};

let copyDelegateBound = false;

/**
 * Copies `text` using the Clipboard API when the page is a secure context,
 * otherwise falls back to a hidden textarea + `document.execCommand("copy")`
 * so LAN HTTP (e.g. http://192.168.x.x) still works.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to execCommand */
    }
  }
  return copyTextFallback(text);
}

function copyTextFallback(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

function markCopied(button: HTMLElement, ok: boolean): void {
  button.classList.toggle("copied", ok);
  button.classList.toggle("copy-failed", !ok);
  window.setTimeout(() => {
    button.classList.remove("copied");
    button.classList.remove("copy-failed");
  }, 1100);
}

/** Document-level click handler for any `[data-copy]` control. */
export function bindCopyButtons(): void {
  if (copyDelegateBound) return;
  copyDelegateBound = true;
  document.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-copy]");
    if (!button) return;
    event.preventDefault();
    void (async () => {
      const ok = await copyText(button.dataset.copy || "");
      markCopied(button, ok);
    })();
  });
}

/** @deprecated Prefer `bindCopyButtons()`; kept so existing callers still attach the delegate. */
export function wireCopyButtons(_root: QueryRoot = document): void {
  bindCopyButtons();
}

/** Lightweight JSON syntax highlighter that returns escaped HTML. */
export function highlightJson(json: string): string {
  return json.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],]/g,
    (match, stringToken: string | undefined, keySuffix: string | undefined) => {
      if (stringToken) {
        const className = keySuffix ? "j-key" : "j-str";
        const suffix = keySuffix ? keySuffix.replace(":", '<span class="j-punc">:</span>') : "";
        return `<span class="${className}">${escapeHtml(stringToken)}</span>${suffix}`;
      }
      if (match === "true" || match === "false" || match === "null") {
        return `<span class="j-bool">${match}</span>`;
      }
      if (/^-?\d/.test(match)) return `<span class="j-num">${match}</span>`;
      return `<span class="j-punc">${escapeHtml(match)}</span>`;
    }
  );
}
