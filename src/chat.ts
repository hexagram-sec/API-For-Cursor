import { errorFromData, errorStatus, RequestError } from "./errors";
import { relayAuthHeaders, hasRelayKey, selectedRelayId } from "./relay-store";
import { escapeAttr, escapeHtml, highlightJson, icon } from "./ui";
import { assistantDisplayContent, sanitizeAssistantContent } from "./chat-sanitize";
import { renderMarkdown } from "./markdown";
import {
  DEFAULT_PROBE_CONCURRENCY,
  DEFAULT_PROBE_PROMPT,
  modelsFromListPayload,
  probeModel,
  runWithConcurrency,
  type ProbeModel,
  type ProbeOutcome
} from "./lab-probe";
import {
  MODEL_STATUS_CHANGED,
  markModelCheck,
  modelOutcome,
  recordModelCheck,
  restoreModelCheck,
  settledCount
} from "./model-status";

/* ============================================================ types */

type Role = "user" | "assistant";
type ApiMode = "chat" | "responses";

interface ChatMessage {
  role: Role;
  content: string;
  images?: ChatImage[];
}

interface ChatImage {
  id: string;
  name: string;
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
  size: number;
}

interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface PersistedState {
  sessions: Session[];
  activeId: string | null;
  model: string;
  mode: ApiMode;
  inspectorOpen: boolean;
}

const FALLBACK_MODELS: ProbeModel[] = [
  { id: "default", name: "Auto" },
  { id: "composer-2.5", name: "Composer 2.5" }
];

const STATE_KEY = "cursor-chat.state.v1";
const MAX_ATTACHMENTS = 4;
const IMAGE_MAX_DIMENSION = 1024;
const IMAGE_TARGET_BYTES = 900 * 1024;
const IMAGE_OUTPUT_TYPE = "image/jpeg";
const CHAT_IMAGE_MAX_WIDTH = 260;
const CHAT_IMAGE_MAX_HEIGHT = 180;
const MOBILE_INSPECTOR_QUERY = "(max-width: 900px)";
const SESSION_TITLE_MAX = 80;

/* ============================================================ state */

// All `/v1` calls authenticate with the relay key chosen in the shell sidebar
// (see `relay-store`). Without a selected key the chat prompts the user to pick
// or create one instead of sending an unauthenticated request.
let catalog: ProbeModel[] = FALLBACK_MODELS.map((model) => ({ ...model }));
let checkingModels = false;
let checkAbort: AbortController | null = null;
let pickerOpen = false;
let modelFilter = "";
let pickerDocBound = false;
let renamingId: string | null = null;

let state: PersistedState = loadState();

function loadState(): PersistedState {
  const fallback: PersistedState = {
    sessions: [],
    activeId: null,
    model: "composer-2.5",
    mode: "chat",
    inspectorOpen: defaultInspectorOpen()
  };
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      sessions: Array.isArray(parsed.sessions) ? (parsed.sessions as Session[]) : [],
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
      model: typeof parsed.model === "string" ? parsed.model : "composer-2.5",
      mode: parsed.mode === "responses" ? "responses" : "chat",
      inspectorOpen: defaultInspectorOpen() && parsed.inspectorOpen !== false
    };
  } catch {
    return fallback;
  }
}

function defaultInspectorOpen(): boolean {
  return !window.matchMedia(MOBILE_INSPECTOR_QUERY).matches;
}

function saveState(): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable - keep running from memory */
  }
}

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function activeSession(): Session | null {
  return state.sessions.find((session) => session.id === state.activeId) ?? null;
}

/* ============================================================ mount */

let busy = false;
let pendingImages: ChatImage[] = [];
let inspectorTouched = false;
let responsiveInspectorBound = false;

export function mountChat(root: HTMLElement): void {
  cleanStoredSessions();
  root.innerHTML = template();
  cacheRefs(root);
  bindEvents();
  bindResponsiveInspector();

  renderSessions();
  renderTranscript();
  renderInspector();
  paintModelPicker();
  bindPickerDismiss();
  syncControls();
  syncResponsiveInspector();
  void initModels();
  refs.composer.focus();
}

async function initModels(): Promise<void> {
  if (!hasRelayKey()) {
    showError("请先在左侧选择一个中转 Key（或到「中转 Key 管理」创建）后再开始对话。");
    return;
  }
  clearError();
  await loadModels();
}

async function loadModels(): Promise<void> {
  if (!hasRelayKey()) return;
  try {
    const response = await fetch("/v1/models", { credentials: "same-origin", headers: relayAuthHeaders() });
    if (!response.ok) return;
    const models = modelsFromListPayload(await response.json());
    if (!models.length) return;
    catalog = models;
    const ids = new Set(models.map((model) => model.id));
    if (!ids.has(state.model)) {
      state.model = ids.has("composer-2.5") ? "composer-2.5" : models[0].id;
      saveState();
    }
    paintModelPicker();
    renderInspector();
  } catch {
    /* Keep the fallback options already rendered. */
  }
}

/* ============================================================ template */

function template(): string {
  return `
  <div class="chat-app" data-inspector="${state.inspectorOpen ? "open" : "closed"}">
    <aside class="chat-sidebar" id="chat-sidebar">
      <div class="chat-sidebar-head">
        <span class="chat-brand">
          <span class="chat-brand-led" aria-hidden="true"></span>
          <span>信道</span>
        </span>
        <button class="btn-new" id="new-chat" type="button">
          ${icon("Plus", { width: 16, height: 16 })}
          <span>新建对话</span>
        </button>
      </div>
      <nav class="session-list" id="session-list" aria-label="会话列表"></nav>
    </aside>

    <main class="chat-main">
      <header class="chat-topbar">
        <button class="icon-button mobile-only" id="sidebar-toggle" type="button" aria-label="切换会话列表">
          ${icon("MessageSquarePlus", { width: 17, height: 17 })}
        </button>
        <h1 class="chat-title" id="chat-title">新建对话</h1>
        <div class="chat-controls">
          <div class="control model-control">
            <span class="control-label">模型</span>
            <div class="model-picker" id="model-picker"></div>
          </div>
          <div class="control">
            <span class="control-label">接口</span>
            <div class="mode-switch" id="mode-switch" role="tablist" aria-label="接口模式">
              <button class="mode-option" data-mode="chat" role="tab" type="button">Chat Completions</button>
              <button class="mode-option" data-mode="responses" role="tab" type="button">Responses API</button>
            </div>
          </div>
          <button class="icon-button" id="inspector-toggle" type="button" aria-label="切换请求预览">
            ${icon("Code2", { width: 17, height: 17 })}
          </button>
        </div>
      </header>

      <div class="chat-body">
        <section class="chat-thread">
          <div class="chat-transcript" id="transcript" aria-live="polite"></div>
          <div class="chat-error" id="chat-error" hidden>
            <span class="chat-error-icon">${icon("TriangleAlert", { width: 16, height: 16 })}</span>
            <span id="chat-error-text"></span>
            <button class="chat-error-close" id="chat-error-close" type="button" aria-label="关闭错误">
              ${icon("X", { width: 14, height: 14 })}
            </button>
          </div>
          <form class="chat-composer" id="chat-form">
            <div class="attachment-tray" id="attachment-tray" hidden></div>
            <div class="composer-row">
              <button class="attach-btn" id="attach-image" type="button" aria-label="添加图片">
                ${icon("ImagePlus", { width: 18, height: 18 })}
              </button>
              <input id="image-input" type="file" accept="image/*" multiple hidden />
              <textarea
                id="composer"
                rows="1"
                placeholder="给 Cursor 发送消息…"
                aria-label="消息"
              ></textarea>
              <button class="send-btn" id="send" type="submit" aria-label="发送消息">
                ${icon("SendHorizontal", { width: 18, height: 18, class: "send-icon" })}
                ${icon("Loader2", { width: 18, height: 18, class: "send-spinner spin" })}
              </button>
            </div>
          </form>
        </section>

        <aside class="chat-inspector" id="inspector" aria-label="请求预览">
          <div class="inspector-head">
            <span class="inspector-title">${icon("Code2", { width: 14, height: 14 })} 请求</span>
            <code class="inspector-route" id="inspector-route"></code>
          </div>
          <pre class="inspector-body"><code id="request-json"></code></pre>
          <p class="inspector-note" id="inspector-note"></p>
        </aside>
      </div>
    </main>
  </div>`;
}

/* ============================================================ refs */

interface Refs {
  app: HTMLElement;
  sessionList: HTMLElement;
  transcript: HTMLElement;
  title: HTMLElement;
  composer: HTMLTextAreaElement;
  form: HTMLFormElement;
  send: HTMLButtonElement;
  attachImage: HTMLButtonElement;
  imageInput: HTMLInputElement;
  attachmentTray: HTMLElement;
  modelPicker: HTMLElement;
  modeSwitch: HTMLElement;
  inspector: HTMLElement;
  requestJson: HTMLElement;
  inspectorRoute: HTMLElement;
  inspectorNote: HTMLElement;
  error: HTMLElement;
  errorText: HTMLElement;
}

const refs = {} as Refs;

function cacheRefs(root: HTMLElement): void {
  const get = <T = HTMLElement>(id: string): T => root.querySelector(`#${id}`)! as unknown as T;
  refs.app = root.querySelector<HTMLElement>(".chat-app")!;
  refs.sessionList = get("session-list");
  refs.transcript = get("transcript");
  refs.title = get("chat-title");
  refs.composer = get<HTMLTextAreaElement>("composer");
  refs.form = get<HTMLFormElement>("chat-form");
  refs.send = get<HTMLButtonElement>("send");
  refs.attachImage = get<HTMLButtonElement>("attach-image");
  refs.imageInput = get<HTMLInputElement>("image-input");
  refs.attachmentTray = get("attachment-tray");
  refs.modelPicker = get("model-picker");
  refs.modeSwitch = get("mode-switch");
  refs.inspector = get("inspector");
  refs.requestJson = get("request-json");
  refs.inspectorRoute = get("inspector-route");
  refs.inspectorNote = get("inspector-note");
  refs.error = get("chat-error");
  refs.errorText = get("chat-error-text");
}

/* ============================================================ events */

function bindEvents(): void {
  refs.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void send();
  });

  refs.composer.addEventListener("input", () => {
    autoGrow();
    renderInspector();
  });
  refs.composer.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void addImageFiles(files);
  });
  refs.composer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      refs.form.requestSubmit();
    }
  });
  refs.form.addEventListener("dragover", (event) => {
    if ([...(event.dataTransfer?.items ?? [])].some((item) => item.type.startsWith("image/"))) {
      event.preventDefault();
      refs.form.classList.add("is-dragging");
    }
  });
  refs.form.addEventListener("dragleave", () => refs.form.classList.remove("is-dragging"));
  refs.form.addEventListener("drop", (event) => {
    const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    refs.form.classList.remove("is-dragging");
    void addImageFiles(files);
  });

  refs.attachImage.addEventListener("click", () => refs.imageInput.click());
  refs.imageInput.addEventListener("change", () => {
    void addImageFiles([...(refs.imageInput.files ?? [])]);
    refs.imageInput.value = "";
  });

  document.getElementById("new-chat")?.addEventListener("click", () => {
    renamingId = null;
    state.activeId = null;
    pendingImages = [];
    saveState();
    renderSessions();
    renderTranscript();
    renderInspector();
    renderPendingImages();
    refs.composer.focus();
  });

  refs.modelPicker.addEventListener("click", onModelPickerClick);
  refs.modelPicker.addEventListener("input", onModelPickerInput);

  refs.modeSwitch.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-mode]");
    if (!button) return;
    state.mode = button.dataset.mode === "responses" ? "responses" : "chat";
    saveState();
    syncControls();
    renderInspector();
  });

  document.getElementById("inspector-toggle")?.addEventListener("click", () => {
    inspectorTouched = true;
    state.inspectorOpen = !state.inspectorOpen;
    refs.app.dataset.inspector = state.inspectorOpen ? "open" : "closed";
    saveState();
  });

  document.getElementById("sidebar-toggle")?.addEventListener("click", () => {
    refs.app.classList.toggle("sidebar-open");
  });

  document.getElementById("chat-error-close")?.addEventListener("click", () => clearError());
}

function bindResponsiveInspector(): void {
  if (responsiveInspectorBound) return;
  responsiveInspectorBound = true;
  window.matchMedia(MOBILE_INSPECTOR_QUERY).addEventListener("change", () => syncResponsiveInspector());
}

function syncResponsiveInspector(): void {
  if (inspectorTouched || !window.matchMedia(MOBILE_INSPECTOR_QUERY).matches || !state.inspectorOpen) return;
  state.inspectorOpen = false;
  refs.app.dataset.inspector = "closed";
  saveState();
}


function bindPickerDismiss(): void {
  if (pickerDocBound) return;
  pickerDocBound = true;
  document.addEventListener("pointerdown", (event) => {
    if (!pickerOpen || !refs.modelPicker?.isConnected) return;
    if (refs.modelPicker.contains(event.target as Node)) return;
    pickerOpen = false;
    paintModelPicker();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !pickerOpen) return;
    pickerOpen = false;
    paintModelPicker();
  });
  window.addEventListener(MODEL_STATUS_CHANGED, () => {
    if (refs.modelPicker?.isConnected) paintModelPicker();
  });
}

function onModelPickerClick(event: MouseEvent): void {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-model-action]");
  if (!target) return;
  const action = target.dataset.modelAction;
  if (action === "toggle") {
    pickerOpen = !pickerOpen;
    paintModelPicker();
    return;
  }
  if (action === "check") {
    void checkModelAvailability();
    return;
  }
  if (action === "stop") {
    checkAbort?.abort();
    return;
  }
  if (action === "select") {
    const id = target.dataset.modelId;
    if (!id) return;
    state.model = id;
    pickerOpen = false;
    saveState();
    paintModelPicker();
    renderInspector();
  }
}

function onModelPickerInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.dataset.modelAction !== "filter") return;
  modelFilter = input.value;
  paintModelPicker();
  const field = refs.modelPicker.querySelector<HTMLInputElement>("[data-model-action='filter']");
  if (field) {
    field.focus();
    field.setSelectionRange(modelFilter.length, modelFilter.length);
  }
}

function currentModel(): ProbeModel {
  return catalog.find((model) => model.id === state.model) ?? catalog[0] ?? FALLBACK_MODELS[0];
}

function availabilityTone(outcome: ProbeOutcome | undefined): string {
  if (!outcome) return "idle";
  if (outcome.status === "ok") return "ok";
  if (outcome.status === "running" || outcome.status === "queued") return "busy";
  if (outcome.status === "cancelled") return "idle";
  return "error";
}

function availabilityLabel(outcome: ProbeOutcome | undefined): string {
  if (!outcome) return "未检测";
  if (outcome.status === "ok") return "可用";
  if (outcome.status === "running" || outcome.status === "queued") return "检测中";
  if (outcome.status === "cancelled") return "已停止";
  return "不可用";
}

function tallyAvailability(): { ok: number; error: number; tested: number } {
  return settledCount(
    catalog.map((model) => model.id),
    selectedRelayId()
  );
}

function paintModelPicker(): void {
  if (!refs.modelPicker?.isConnected) return;
  const selected = currentModel();
  const selectedOutcome = modelOutcome(selected.id, selectedRelayId());
  const query = modelFilter.trim().toLowerCase();
  const visible = catalog.filter((model) => {
    if (!query) return true;
    return model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query);
  });
  const counts = tallyAvailability();
  const list = refs.modelPicker.querySelector<HTMLElement>("[data-model-list]");
  const scrollTop = list?.scrollTop ?? 0;
  const filterEl = refs.modelPicker.querySelector<HTMLInputElement>("[data-model-action='filter']");
  const filterFocused = document.activeElement === filterEl;
  const filterStart = filterEl?.selectionStart ?? modelFilter.length;
  const filterEnd = filterEl?.selectionEnd ?? modelFilter.length;
  const ready = hasRelayKey();

  refs.modelPicker.innerHTML = `
    <button class="model-picker-trigger" type="button" data-model-action="toggle" aria-haspopup="listbox" aria-expanded="${pickerOpen ? "true" : "false"}">
      <span class="model-dot" data-tone="${escapeAttr(availabilityTone(selectedOutcome))}"></span>
      <span class="model-picker-name">${escapeHtml(selected.name)}</span>
      ${icon("ChevronDown", { width: 14, height: 14, class: "select-caret" })}
    </button>
    <div class="model-picker-panel" ${pickerOpen ? "" : "hidden"}>
      <div class="model-picker-toolbar">
        <div>
          <strong>模型可用性</strong>
          <p>${
            checkingModels
              ? `已检测 ${counts.ok + counts.error} / ${catalog.length}…`
              : counts.tested
                ? `${counts.ok} 个可用 · ${counts.error} 个不可用（最近一次测试）`
                : `${catalog.length} 个模型 · 尚未测试`
          }</p>
        </div>
        <button class="btn btn-glass model-picker-check" type="button" data-model-action="${checkingModels ? "stop" : "check"}" ${ready ? "" : "disabled"}>
          ${checkingModels ? icon("X", { width: 14, height: 14 }) : icon("Zap", { width: 14, height: 14 })}
          <span>${checkingModels ? "停止" : "检测"}</span>
        </button>
      </div>
      <input class="model-picker-filter" data-model-action="filter" type="search" placeholder="筛选模型" value="${escapeAttr(modelFilter)}" ${pickerOpen ? "" : "tabindex='-1'"} />
      <ul class="model-picker-list" data-model-list role="listbox" aria-label="模型">
        ${
          visible.length
            ? visible
                .map((model) => {
                  const outcome = modelOutcome(model.id, selectedRelayId());
                  const active = model.id === state.model;
                  const detail = outcome?.status === "error" ? outcome.error || "不可用" : outcome?.status === "ok" ? `${outcome.ms ?? 0} ms` : "";
                  return `
                    <li>
                      <button class="model-picker-option${active ? " is-active" : ""}" type="button" role="option" aria-selected="${active ? "true" : "false"}" data-model-action="select" data-model-id="${escapeAttr(model.id)}" title="${escapeAttr(detail)}">
                        <span class="model-dot" data-tone="${escapeAttr(availabilityTone(outcome))}"></span>
                        <span class="model-picker-option-copy">
                          <strong>${escapeHtml(model.name)}</strong>
                          <code>${escapeHtml(model.id)}</code>
                        </span>
                        <span class="model-picker-option-status">${escapeHtml(availabilityLabel(outcome))}</span>
                      </button>
                    </li>
                  `;
                })
                .join("")
            : `<li class="model-picker-empty">没有匹配“${escapeHtml(modelFilter)}”的模型。</li>`
        }
      </ul>
    </div>
  `;
  const nextList = refs.modelPicker.querySelector<HTMLElement>("[data-model-list]");
  if (nextList) nextList.scrollTop = scrollTop;
  if (filterFocused) {
    const field = refs.modelPicker.querySelector<HTMLInputElement>("[data-model-action='filter']");
    if (field) {
      field.focus();
      field.setSelectionRange(filterStart, filterEnd);
    }
  }
}

async function checkModelAvailability(ids = catalog.map((model) => model.id)): Promise<void> {
  if (checkingModels || !hasRelayKey() || ids.length === 0) return;
  checkingModels = true;
  const controller = new AbortController();
  checkAbort = controller;
  const relayId = selectedRelayId();
  for (const id of ids) markModelCheck(id, "queued", relayId);
  paintModelPicker();
  await runWithConcurrency(
    ids,
    DEFAULT_PROBE_CONCURRENCY,
    async (id) => {
      if (controller.signal.aborted) {
        restoreModelCheck(id, relayId);
        paintModelPicker();
        return;
      }
      markModelCheck(id, "running", relayId);
      paintModelPicker();
      const outcome = await probeModel(id, DEFAULT_PROBE_PROMPT, controller.signal, relayAuthHeaders());
      if (outcome.status === "cancelled") restoreModelCheck(id, relayId);
      else recordModelCheck(outcome, relayId);
      paintModelPicker();
    },
    controller.signal
  );
  for (const id of ids) {
    const outcome = modelOutcome(id, relayId);
    if (outcome?.status === "queued" || outcome?.status === "running") restoreModelCheck(id, relayId);
  }
  checkingModels = false;
  checkAbort = null;
  paintModelPicker();
}

/* ============================================================ rendering */

function syncControls(): void {
  paintModelPicker();
  for (const button of refs.modeSwitch.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  }
  refs.app.dataset.inspector = state.inspectorOpen ? "open" : "closed";
}

function renderSessions(): void {
  if (!state.sessions.length) {
    refs.sessionList.innerHTML = `<p class="session-empty">还没有对话。</p>`;
    refs.title.textContent = "新建对话";
    return;
  }
  const ordered = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  refs.sessionList.innerHTML = ordered
    .map((session) => {
      const active = session.id === state.activeId;
      const renaming = session.id === renamingId;
      if (renaming) {
        return `
      <div class="session-row is-renaming${active ? " is-active" : ""}" data-id="${session.id}">
        <form class="session-rename" data-rename-form>
          <input
            class="session-rename-input"
            name="title"
            type="text"
            maxlength="${SESSION_TITLE_MAX}"
            value="${escapeAttr(session.title)}"
            aria-label="信道名称"
            autocomplete="off"
            spellcheck="false"
          />
        </form>
        <span class="session-tools">
          <button class="session-tool" type="button" data-action="rename-save" data-id="${session.id}" aria-label="保存名称" title="保存">
            ${icon("Check", { width: 13, height: 13 })}
          </button>
          <button class="session-tool" type="button" data-action="rename-cancel" data-id="${session.id}" aria-label="取消" title="取消">
            ${icon("X", { width: 13, height: 13 })}
          </button>
        </span>
      </div>`;
      }
      return `
      <div class="session-row ${active ? "is-active" : ""}" data-id="${session.id}">
        <button class="session-open" type="button" data-action="open" data-id="${session.id}">
          ${icon("MessageSquarePlus", { width: 14, height: 14 })}
          <span class="session-name">${escapeHtml(session.title)}</span>
        </button>
        <span class="session-tools">
          <button class="session-tool" type="button" data-action="rename" data-id="${session.id}" aria-label="重命名" title="重命名">
            ${icon("Pencil", { width: 13, height: 13 })}
          </button>
          <button class="session-tool" type="button" data-action="delete" data-id="${session.id}" aria-label="删除" title="删除">
            ${icon("Trash2", { width: 13, height: 13 })}
          </button>
        </span>
      </div>`;
    })
    .join("");

  bindSessionList();

  const session = activeSession();
  refs.title.textContent = session ? session.title : "新建对话";
  if (renamingId) focusRenameField();
}

function bindSessionList(): void {
  const form = refs.sessionList.querySelector<HTMLFormElement>("[data-rename-form]");
  const input = form?.querySelector<HTMLInputElement>(".session-rename-input");
  if (form && input) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      commitRename(renamingId, input.value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelRename();
    });
    input.addEventListener("input", () => {
      const session = activeSession();
      if (session && session.id === renamingId) refs.title.textContent = input.value.trim() || session.title;
    });
    for (const button of refs.sessionList.querySelectorAll<HTMLButtonElement>("[data-action='rename-save'], [data-action='rename-cancel']")) {
      button.addEventListener("mousedown", (event) => event.preventDefault());
    }
  }

  for (const button of refs.sessionList.querySelectorAll<HTMLButtonElement>("[data-action]")) {
    button.addEventListener("click", () => {
      const id = button.dataset.id || "";
      const action = button.dataset.action;
      if (action === "open") openSession(id);
      else if (action === "rename") beginRename(id);
      else if (action === "rename-save") commitRename(id, input?.value ?? "");
      else if (action === "rename-cancel") cancelRename();
      else if (action === "delete") deleteSession(id);
    });
  }
}

function focusRenameField(): void {
  const input = refs.sessionList.querySelector<HTMLInputElement>(".session-rename-input");
  if (!input) return;
  input.focus();
  input.select();
}

function beginRename(id: string): void {
  if (!state.sessions.some((session) => session.id === id)) return;
  renamingId = id;
  renderSessions();
}

function commitRename(id: string | null, raw: string): void {
  if (!id) return;
  const session = state.sessions.find((entry) => entry.id === id);
  if (!session) {
    cancelRename();
    return;
  }
  const trimmed = raw.trim().slice(0, SESSION_TITLE_MAX);
  if (trimmed && trimmed !== session.title) {
    session.title = trimmed;
    session.updatedAt = Date.now();
    saveState();
  }
  renamingId = null;
  renderSessions();
}

function cancelRename(): void {
  renamingId = null;
  renderSessions();
}

function openSession(id: string): void {
  if (busy) return;
  renamingId = null;
  state.activeId = id;
  saveState();
  refs.app.classList.remove("sidebar-open");
  renderSessions();
  renderTranscript();
  renderInspector();
}

function deleteSession(id: string): void {
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return;
  if (!window.confirm(`删除“${session.title}”？`)) return;
  if (renamingId === id) renamingId = null;
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.activeId === id) state.activeId = null;
  saveState();
  renderSessions();
  renderTranscript();
  renderInspector();
}

function renderTranscript(streaming?: HTMLElement): void {
  const session = activeSession();
  const messages = session?.messages ?? [];
  if (!messages.length && !streaming) {
    refs.transcript.innerHTML = `
      <div class="transcript-empty">
        <span class="transcript-empty-mark">${icon("Sparkles", { width: 26, height: 26 })}</span>
        <h2>Cursor 对话</h2>
        <p>通过标准的 OpenAI 风格接口，以流式方式与 Cursor Composer 对话。</p>
      </div>`;
    return;
  }
  refs.transcript.innerHTML = "";
  for (const message of messages) {
    refs.transcript.appendChild(messageNode(message.role, message.content, message.images));
  }
  if (streaming) refs.transcript.appendChild(streaming);
  refs.transcript.scrollTop = refs.transcript.scrollHeight;
}

function messageNode(role: Role, content: string, images: ChatImage[] = []): HTMLElement {
  const node = document.createElement("article");
  node.className = `chat-msg chat-msg-${role}`;
  node.innerHTML = `
    <span class="chat-msg-avatar">${icon(role === "user" ? "User" : "Sparkles", { width: 15, height: 15 })}</span>
    <div class="chat-msg-bubble"></div>`;
  const bubble = node.querySelector<HTMLElement>(".chat-msg-bubble")!;
  if (role === "assistant") {
    bubble.innerHTML = renderAssistantContent(content);
  } else {
    bubble.innerHTML = renderUserContent(content, images);
  }
  return node;
}

function renderUserContent(content: string, images: ChatImage[]): string {
  const imageHtml = images.length
    ? `<div class="chat-image-grid">${images.map((image) => userImageHtml(image)).join("")}</div>`
    : "";
  const textHtml = content ? `<p>${escapeHtml(content)}</p>` : "";
  return `${imageHtml}${textHtml}`;
}

function userImageHtml(image: ChatImage): string {
  const src = image.dataUrl.startsWith("data:image/") ? image.dataUrl : "";
  const style = imagePreviewStyle(image, CHAT_IMAGE_MAX_WIDTH, CHAT_IMAGE_MAX_HEIGHT);
  return `
    <figure class="chat-image" style="${style}">
      <span class="chat-image-frame">
        <img src="${escapeAttr(src)}" alt="${escapeAttr(image.name || "Attached image")}" />
      </span>
      <figcaption>${escapeHtml(image.name || "Image")} · ${image.width}×${image.height}</figcaption>
    </figure>`;
}

function renderAssistantContent(content: string): string {
  const cleaned = assistantDisplayContent(content);
  if (!cleaned) return "";
  return renderMarkdown(cleaned, { headingIds: false }).html;
}

/* ============================================================ request preview */

function buildRequestBody(draft?: string, images: ChatImage[] = []): Record<string, unknown> {
  const session = activeSession();
  const history = sanitizeHistory(session?.messages ?? []);
  if (draft || images.length) history.push({ role: "user", content: draft || "", ...(images.length ? { images } : {}) });

  if (state.mode === "responses") {
    return {
      model: state.model,
      input: history.map(responseMessageForApi),
      stream: true
    };
  }
  return {
    model: state.model,
    messages: history.map(chatMessageForApi),
    stream: true
  };
}

function chatMessageForApi(message: ChatMessage): Record<string, unknown> {
  const images = message.images ?? [];
  if (!images.length) return { role: message.role, content: message.content };
  const content: Array<Record<string, unknown>> = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const image of images) {
    content.push({
      type: "image_url",
      image_url: {
        url: image.dataUrl,
        detail: "auto",
        width: image.width,
        height: image.height
      }
    });
  }
  return { role: message.role, content };
}

function responseMessageForApi(message: ChatMessage): Record<string, unknown> {
  const images = message.images ?? [];
  if (!images.length) return { role: message.role, content: message.content };
  const content: Array<Record<string, unknown>> = [];
  if (message.content) content.push({ type: "input_text", text: message.content });
  for (const image of images) {
    content.push({
      type: "input_image",
      image_url: {
        url: image.dataUrl,
        detail: "auto",
        width: image.width,
        height: image.height
      }
    });
  }
  return { role: message.role, content };
}

function endpointFor(mode: ApiMode): string {
  return mode === "responses" ? "/v1/responses" : "/v1/chat/completions";
}

function renderInspector(): void {
  const draft = refs.composer.value.trim();
  const body = buildRequestBody(draft || undefined, pendingImages);
  refs.requestJson.innerHTML = highlightJson(JSON.stringify(redactPreviewImages(body), null, 2));
  refs.inspectorRoute.textContent = `POST ${endpointFor(state.mode)}`;
  refs.inspectorNote.textContent =
    state.mode === "responses"
      ? "Responses API —— 请求体使用 `input`，以 response.output_text.delta 事件流式返回。图片会在发送前压缩。"
      : "Chat Completions —— 请求体使用 `messages`，以 chat.completion.chunk 事件流式返回。图片会在发送前压缩。";
}

function redactPreviewImages(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("data:image/")) {
    const approxBytes = Math.round((value.length * 3) / 4);
    return `${value.slice(0, value.indexOf(",") + 1)}<${formatBytes(approxBytes)} base64 image>`;
  }
  if (Array.isArray(value)) return value.map(redactPreviewImages);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactPreviewImages(item)]));
  }
  return value;
}

/* ============================================================ sending */

function sanitizeHistory(history: ChatMessage[]): ChatMessage[] {
  const cleaned: ChatMessage[] = [];
  for (const message of history) {
    if (message.role !== "assistant") {
      const images = sanitizeImages(message.images);
      cleaned.push({ role: message.role, content: message.content, ...(images.length ? { images } : {}) });
      continue;
    }
    const content = sanitizeAssistantContent(message.content);
    if (content) cleaned.push({ role: "assistant", content });
  }
  return cleaned;
}

function sanitizeImages(images: unknown): ChatImage[] {
  if (!Array.isArray(images)) return [];
  return images
    .filter((image): image is ChatImage => {
      if (!image || typeof image !== "object") return false;
      const item = image as Partial<ChatImage>;
      return (
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        typeof item.dataUrl === "string" &&
        item.dataUrl.startsWith("data:image/") &&
        typeof item.mimeType === "string" &&
        typeof item.width === "number" &&
        typeof item.height === "number" &&
        typeof item.size === "number"
      );
    })
    .slice(0, MAX_ATTACHMENTS);
}

function cleanStoredSessions(): void {
  let changed = false;
  for (const session of state.sessions) {
    const cleaned = sanitizeHistory(session.messages);
    if (
      cleaned.length !== session.messages.length ||
      cleaned.some(
        (message, index) =>
          message.content !== session.messages[index]?.content ||
          (message.images?.length ?? 0) !== (session.messages[index]?.images?.length ?? 0)
      )
    ) {
      session.messages = cleaned;
      changed = true;
    }
  }
  if (changed) saveState();
}

function ensureSession(firstPrompt: string): Session {
  let session = activeSession();
  if (!session) {
    session = {
      id: uid("sess"),
      title: firstPrompt.slice(0, 48).trim() || "New chat",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    state.sessions.push(session);
    state.activeId = session.id;
  }
  return session;
}

async function send(): Promise<void> {
  if (busy) return;
  const prompt = refs.composer.value.trim();
  const images = pendingImages;
  if (!prompt && !images.length) return;
  if (!hasRelayKey()) {
    showError("请先在左侧选择一个中转 Key（或到「中转 Key 管理」创建）后再发送。");
    return;
  }

  clearError();
  const session = ensureSession(prompt || images[0]?.name || "图片");
  session.messages.push({ role: "user", content: prompt, ...(images.length ? { images } : {}) });
  session.updatedAt = Date.now();
  if (session.messages.length === 1) session.title = (prompt || images[0]?.name || "图片").slice(0, 48).trim() || "新建对话";
  saveState();

  refs.composer.value = "";
  pendingImages = [];
  renderPendingImages();
  autoGrow();
  setBusy(true);
  renderSessions();
  renderTranscript();
  renderInspector();

  const pending = messageNode("assistant", "");
  pending.classList.add("is-streaming");
  const bubble = pending.querySelector<HTMLElement>(".chat-msg-bubble")!;
  renderTranscript(pending);

  const mode = state.mode;
  let received = "";
  const requestBody = buildRequestBody();

  try {
    try {
      const response = await sendRequest(mode, requestBody);
      if (!response.body) throw new Error("请求在流开始前就失败了。");
      const stream = mode === "responses" ? readResponseDeltas(response.body) : readChatDeltas(response.body);
      for await (const delta of stream) {
        received += delta;
        bubble.innerHTML = renderAssistantContent(received);
        refs.transcript.scrollTop = refs.transcript.scrollHeight;
      }
    } catch (error) {
      if (received || !isStreamLoadFailure(error)) throw error;
      received = await sendBufferedRetry(mode, requestBody);
      bubble.innerHTML = renderAssistantContent(received);
      refs.transcript.scrollTop = refs.transcript.scrollHeight;
    }

    const answer = sanitizeAssistantContent(received);
    if (!answer) throw new Error(`${state.model} 返回了空响应。`);
    session.messages.push({ role: "assistant", content: answer });
    session.updatedAt = Date.now();
    saveState();
    pending.classList.remove("is-streaming");
    renderTranscript();
  } catch (error) {
    // Errors are surfaced in a banner, never persisted as assistant content.
    pending.remove();
    renderTranscript();
    if (errorStatus(error) === 401) {
      showError("当前中转 Key 无效或已被停用，请在左侧重新选择或到「中转 Key 管理」创建。");
    } else {
      showError(error instanceof Error ? error.message : "发生未知错误。");
    }
  } finally {
    setBusy(false);
    renderInspector();
    refs.composer.focus();
  }
}

async function sendRequest(mode: ApiMode, body: Record<string, unknown>): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...relayAuthHeaders() };
  const response = await fetch(endpointFor(mode), {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) throw await responseError(response);
  return response;
}

async function sendBufferedRetry(mode: ApiMode, body: Record<string, unknown>): Promise<string> {
  const response = await sendRequest(mode, { ...body, stream: false });
  const payload = (await response.json()) as Record<string, unknown>;
  const text = mode === "responses" ? bufferedResponseText(payload) : bufferedChatText(payload);
  if (!text) throw new Error("重试完成但未返回文本。");
  return text;
}

async function responseError(response: Response): Promise<Error> {
  const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  return new RequestError(payload.error?.message || `请求失败（${response.status}）。`, response.status);
}


function isStreamLoadFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /load failed|networkerror|failed to fetch|network request failed/i.test(error.message);
}

function bufferedChatText(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  return typeof first?.message?.content === "string" ? first.message.content : "";
}

function bufferedResponseText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  const parts: string[] = [];
  for (const item of output as Array<{ content?: unknown }>) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content as Array<{ text?: unknown }>) {
      if (typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("");
}

function setBusy(value: boolean): void {
  busy = value;
  refs.send.disabled = value;
  refs.composer.disabled = value;
  refs.attachImage.disabled = value;
  refs.imageInput.disabled = value;
  refs.app.classList.toggle("is-busy", value);
}

function showError(message: string): void {
  refs.errorText.textContent = message;
  refs.error.hidden = false;
}

function clearError(): void {
  refs.error.hidden = true;
  refs.errorText.textContent = "";
}

function autoGrow(): void {
  refs.composer.style.height = "auto";
  refs.composer.style.height = `${Math.min(refs.composer.scrollHeight, 200)}px`;
}

/* ============================================================ image input */

async function addImageFiles(files: File[]): Promise<void> {
  clearError();
  const imageFiles = files.filter((file) => file.type.startsWith("image/"));
  if (!imageFiles.length) return;
  const slots = MAX_ATTACHMENTS - pendingImages.length;
  if (slots <= 0) {
    showError(`每次最多添加 ${MAX_ATTACHMENTS} 张图片。`);
    return;
  }
  const selected = imageFiles.slice(0, slots);
  try {
    const resized = await Promise.all(selected.map(resizeImageFile));
    pendingImages = [...pendingImages, ...resized];
    renderPendingImages();
    renderInspector();
  } catch (error) {
    showError(error instanceof Error ? error.message : "无法处理该图片。");
  }
  if (imageFiles.length > selected.length) {
    showError(`一次最多只能附加 ${MAX_ATTACHMENTS} 张图片。`);
  }
}

function renderPendingImages(): void {
  refs.attachmentTray.hidden = pendingImages.length === 0;
  refs.attachmentTray.innerHTML = pendingImages
    .map(
      (image) => `
      <figure class="attachment-chip" data-id="${escapeAttr(image.id)}" style="${imagePreviewStyle(image, 48, 42)}">
        <span class="attachment-thumb">
          <img src="${escapeAttr(image.dataUrl)}" alt="${escapeAttr(image.name)}" />
        </span>
        <figcaption>${escapeHtml(image.name)} <span>${image.width}×${image.height}</span></figcaption>
        <button type="button" aria-label="移除 ${escapeAttr(image.name)}" data-remove-image="${escapeAttr(image.id)}">
          ${icon("X", { width: 13, height: 13 })}
        </button>
      </figure>`
    )
    .join("");
  for (const button of refs.attachmentTray.querySelectorAll<HTMLButtonElement>("[data-remove-image]")) {
    button.addEventListener("click", () => {
      pendingImages = pendingImages.filter((image) => image.id !== button.dataset.removeImage);
      renderPendingImages();
      renderInspector();
      refs.composer.focus();
    });
  }
}

function imagePreviewStyle(image: ChatImage, maxWidth: number, maxHeight: number): string {
  const width = Math.max(1, image.width);
  const height = Math.max(1, image.height);
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const previewWidth = Math.max(1, Math.round(width * scale));
  const previewHeight = Math.max(1, Math.round(height * scale));
  return `--image-aspect: ${width} / ${height}; --preview-width: ${previewWidth}px; --preview-height: ${previewHeight}px;`;
}

async function resizeImageFile(file: File): Promise<ChatImage> {
  const { image, dispose } = await loadImage(file);
  try {
    let scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
    let width = Math.max(1, Math.round(image.naturalWidth * scale));
    let height = Math.max(1, Math.round(image.naturalHeight * scale));
    let quality = 0.86;
    let blob = await drawImageToBlob(image, width, height, quality);

    while (blob.size > IMAGE_TARGET_BYTES && quality > 0.5) {
      quality = Math.max(0.5, quality - 0.08);
      blob = await drawImageToBlob(image, width, height, quality);
    }
    while (blob.size > IMAGE_TARGET_BYTES && Math.max(width, height) > 512) {
      scale *= 0.85;
      width = Math.max(1, Math.round(image.naturalWidth * scale));
      height = Math.max(1, Math.round(image.naturalHeight * scale));
      blob = await drawImageToBlob(image, width, height, quality);
    }
    if (blob.size > 1024 * 1024) {
      throw new Error("压缩后图片仍超过 1MB，请换一张更小的图片。");
    }

    return {
      id: uid("img"),
      name: file.name || "image.jpg",
      dataUrl: await blobToDataUrl(blob),
      mimeType: blob.type || IMAGE_OUTPUT_TYPE,
      width,
      height,
      size: blob.size
    };
  } finally {
    dispose();
  }
}

async function loadImage(file: File): Promise<{ image: HTMLImageElement; dispose: () => void }> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  const decode = (image as HTMLImageElement & { decode?: () => Promise<void> }).decode;
  if (typeof decode === "function") await decode.call(image);
  else {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("无法读取该图片。"));
    });
  }
  return { image, dispose: () => URL.revokeObjectURL(url) };
}

async function drawImageToBlob(image: HTMLImageElement, width: number, height: number, quality: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法处理该图片。");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("无法编码该图片。"))), IMAGE_OUTPUT_TYPE, quality);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取压缩后的图片。"));
    reader.readAsDataURL(blob);
  });
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/* ============================================================ SSE parsing */

interface SseFrame {
  event: string;
  data: string;
}

async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parse = (raw: string): SseFrame | null => {
    let event = "";
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!event && !data.length) return null;
    return { event, data: data.join("\n") };
  };

  const boundary = (text: string): { index: number; length: number } => {
    const lf = text.indexOf("\n\n");
    const crlf = text.indexOf("\r\n\r\n");
    if (lf === -1 && crlf === -1) return { index: -1, length: 0 };
    if (crlf === -1 || (lf !== -1 && lf < crlf)) return { index: lf, length: 2 };
    return { index: crlf, length: 4 };
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let edge = boundary(buffer);
    while (edge.index !== -1) {
      const frame = parse(buffer.slice(0, edge.index));
      buffer = buffer.slice(edge.index + edge.length);
      if (frame) yield frame;
      edge = boundary(buffer);
    }
  }
  if (buffer.trim()) {
    const frame = parse(buffer);
    if (frame) yield frame;
  }
}

/** Chat Completions SSE: `chat.completion.chunk` data frames. */
async function* readChatDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const frame of readSseFrames(body)) {
    if (frame.event === "error") throw errorFromData(frame.data, "Cursor 流返回了错误。");
    const data = frame.data.trim();
    if (!data || data === "[DONE]") {
      if (data === "[DONE]") return;
      continue;
    }
    let chunk: { choices?: Array<{ delta?: { content?: string } }>; error?: { message?: string; status?: number } };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) throw errorFromData(data, "Cursor 流返回了错误。");
    const content = chunk.choices?.[0]?.delta?.content;
    if (content) yield content;
  }
}

/** Responses API SSE: `response.output_text.delta` / `response.completed` / `error`. */
async function* readResponseDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const frame of readSseFrames(body)) {
    if (frame.event === "error") throw errorFromData(frame.data, "Cursor 流返回了错误。");
    const data = frame.data.trim();
    if (!data) continue;
    let payload: {
      type?: string;
      delta?: string;
      response?: { error?: { message?: string } | null };
      error?: { message?: string };
    };
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    const type = payload.type || frame.event;
    if (type === "error" || payload.error) {
      throw new Error(payload.error?.message || "Cursor 流返回了错误。");
    }
    if (type === "response.output_text.delta" && typeof payload.delta === "string") {
      yield payload.delta;
    }
    if (type === "response.completed") {
      if (payload.response?.error) throw new Error(payload.response.error.message || "响应失败。");
      return;
    }
    if (type === "response.failed" || type === "response.incomplete") {
      throw new Error(payload.response?.error?.message || "响应未完成。");
    }
  }
}

