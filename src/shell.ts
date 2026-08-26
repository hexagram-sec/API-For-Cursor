import { bindCopyButtons, icon, type IconName } from "./ui";
import { refreshRelayKeys, relayOptions, selectedRelayId, setSelectedRelay, selectedRelayName } from "./relay-store";

interface SessionState {
  authRequired: boolean;
  authenticated: boolean;
}

interface MenuItem {
  route: string;
  label: string;
  icon: IconName;
  title: string;
}

interface MenuGroup {
  label: string;
  items: MenuItem[];
}

const MENU_GROUPS: MenuGroup[] = [
  {
    label: "使用",
    items: [
      { route: "/chat", label: "对话", icon: "MessageSquarePlus", title: "对话" },
      { route: "/lab", label: "实验室", icon: "Sparkles", title: "模型实验室" }
    ]
  },
  {
    label: "密钥",
    items: [
      { route: "/console/cursor-keys", label: "Cursor Token", icon: "Server", title: "Cursor Token" },
      { route: "/console/relay-keys", label: "中转 Key", icon: "KeyRound", title: "中转 Key" }
    ]
  },
  {
    label: "系统",
    items: [
      { route: "/console/settings", label: "设置", icon: "Lock", title: "设置" },
      { route: "/console/access-logs", label: "访问日志", icon: "ScrollText", title: "访问日志" }
    ]
  }
];

const MENU: MenuItem[] = MENU_GROUPS.flatMap((group) => group.items);

const DEFAULT_ROUTE = "/console/cursor-keys";
const RELAY_ROUTES = new Set(["/chat", "/lab"]);

let app: HTMLElement;
let content: HTMLElement | null = null;
let session: SessionState = { authRequired: false, authenticated: true };
let currentRoute = DEFAULT_ROUTE;
let listenersBound = false;

export async function startShell(): Promise<void> {
  const host = document.getElementById("app");
  if (!host) return;
  app = host;
  bindCopyButtons();
  bindGlobalListeners();
  session = await fetchSession();
  if (session.authRequired && !session.authenticated) {
    renderLogin();
    return;
  }
  await enterConsole(normalizeRoute(window.location.pathname));
}

async function fetchSession(): Promise<SessionState> {
  try {
    const response = await fetch("/api/console/session", { credentials: "same-origin" });
    if (!response.ok) return { authRequired: false, authenticated: true };
    return (await response.json()) as SessionState;
  } catch {
    return { authRequired: false, authenticated: true };
  }
}

/** Loads relay keys, renders the persistent shell and routes to `route`. */
async function enterConsole(route: string): Promise<void> {
  await refreshRelayKeys();
  renderShell();
  await navigate(route, false);
}

/* ---------- Login gate ---------- */

function renderLogin(): void {
  content = null;
  app.innerHTML = `
    <div class="hatch">
      <section class="hatch-card fiducial">
        <p class="page-kicker">STATION ACCESS</p>
        <h1>进入中继站</h1>
        <form class="console-login" data-form="login">
          <label class="console-field">
            <span>后台密码</span>
            <input type="password" autocomplete="current-password" required data-login-password />
          </label>
          <button class="btn btn-primary console-btn" type="submit">
            ${icon("ArrowRight", { width: 16, height: 16 })}
            <span>进入控制台</span>
          </button>
        </form>
        <p class="console-note" data-login-message></p>
      </section>
    </div>
  `;
  (app.querySelector("[data-login-password]") as HTMLInputElement | null)?.focus();
}

async function submitLogin(form: HTMLFormElement): Promise<void> {
  const input = form.querySelector("[data-login-password]") as HTMLInputElement | null;
  const message = app.querySelector("[data-login-message]") as HTMLElement | null;
  const submit = form.querySelector("button[type=submit]") as HTMLButtonElement | null;
  const password = input?.value ?? "";
  if (!password || !message || !submit) return;

  setNote(message, "busy", "正在登录…");
  submit.disabled = true;
  try {
    const response = await fetch("/api/console/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      setNote(message, "error", payload.error?.message || `登录失败（HTTP ${response.status}）。`);
      input?.select();
      return;
    }
    session = { authRequired: true, authenticated: true };
    await enterConsole(normalizeRoute(window.location.pathname));
  } catch {
    setNote(message, "error", "无法连接服务，请确认服务是否仍在运行。");
  } finally {
    submit.disabled = false;
  }
}

async function signOut(): Promise<void> {
  try {
    await fetch("/api/console/logout", { method: "POST" });
  } catch {
    /* Falling through still drops the local view. */
  }
  session = { authRequired: true, authenticated: false };
  document.body.classList.remove("nav-open");
  renderLogin();
}

/* ---------- Shell ---------- */

function renderShell(): void {
  app.innerHTML = `
    <div class="admin-shell">
      <button class="admin-scrim" type="button" data-action="close-nav" tabindex="-1" aria-hidden="true"></button>
      <aside class="admin-sidebar" id="admin-sidebar">
        <div class="admin-rail" aria-hidden="true"></div>
        <div class="admin-brand">
          <span class="admin-mark" aria-hidden="true"></span>
          <div>
            <strong>API for Cursor</strong>
            <span>中继控制台</span>
          </div>
          <button class="admin-nav-close" type="button" data-action="close-nav" aria-label="关闭菜单">
            ${icon("X", { width: 16, height: 16 })}
          </button>
        </div>
        <nav class="admin-menu">
          ${MENU_GROUPS.map(
            (group) => `
            <p class="admin-menu-label">${group.label}</p>
            ${group.items
              .map(
                (item) => `
            <button class="admin-menu-item" type="button" data-route="${item.route}">
              <span class="admin-port" aria-hidden="true"></span>
              <span class="admin-menu-icon">${icon(item.icon, { width: 16, height: 16 })}</span>
              <span>${item.label}</span>
            </button>`
              )
              .join("")}`
          ).join("")}
        </nav>
        <div class="admin-sidebar-foot">
          <label class="admin-relay-pick">
            <span>工作端口</span>
            <select class="admin-input" data-relay-select></select>
          </label>
          <p class="admin-relay-hint" data-relay-hint></p>
          <div data-signout-slot></div>
        </div>
      </aside>
      <div class="admin-stage">
        <header class="admin-topbar">
          <button class="admin-nav-toggle" type="button" data-action="toggle-nav" aria-label="打开菜单" aria-controls="admin-sidebar">
            ${icon("Menu", { width: 18, height: 18 })}
          </button>
          <span class="admin-topbar-title" data-topbar-title>控制台</span>
        </header>
        <main class="admin-content" id="app-content"></main>
      </div>
    </div>
  `;
  content = app.querySelector<HTMLElement>("#app-content");
  bindShellEvents();
  paintRelaySelector();
  paintSignOut();
}

function bindShellEvents(): void {
  const shell = app.querySelector(".admin-shell");
  if (!shell) return;

  shell.addEventListener("click", (event) => {
    const menuButton = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-route]");
    if (menuButton) {
      setNavOpen(false);
      void navigate(menuButton.dataset.route ?? DEFAULT_ROUTE, true);
      return;
    }
    const action = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-action]");
    if (action?.dataset.action === "sign-out") {
      setNavOpen(false);
      void signOut();
      return;
    }
    if (action?.dataset.action === "toggle-nav") {
      setNavOpen(!app.querySelector(".admin-shell")?.classList.contains("is-nav-open"));
      return;
    }
    if (action?.dataset.action === "close-nav") setNavOpen(false);
  });

  const select = app.querySelector("[data-relay-select]") as HTMLSelectElement | null;
  select?.addEventListener("change", () => {
    setSelectedRelay(select.value || null);
    updateRelayHint();
    if (RELAY_ROUTES.has(currentRoute)) void mountSection(currentRoute);
  });
}

function paintRelaySelector(): void {
  const select = app.querySelector("[data-relay-select]") as HTMLSelectElement | null;
  if (!select) return;
  const keys = relayOptions();
  if (keys.length === 0) {
    select.innerHTML = `<option value="">暂无可用中转 Key</option>`;
    select.disabled = true;
  } else {
    select.disabled = false;
    select.innerHTML = keys.map((key) => `<option value="${key.id}">${escapeOption(key.name)}</option>`).join("");
    select.value = selectedRelayId() ?? keys[0].id;
    setSelectedRelay(select.value);
  }
  updateRelayHint();
}

function paintSignOut(): void {
  const slot = app.querySelector("[data-signout-slot]");
  if (!slot) return;
  slot.innerHTML = session.authRequired
    ? `<button class="admin-signout" type="button" data-action="sign-out">${icon("LogOut", { width: 15, height: 15 })}<span>退出</span></button>`
    : "";
}

function updateRelayHint(): void {
  const hint = app.querySelector("[data-relay-hint]") as HTMLElement | null;
  if (!hint) return;
  const name = selectedRelayName();
  if (name) {
    hint.textContent = `对话和实验室走「${name}」这条端口`;
    hint.dataset.tone = "idle";
  } else {
    hint.textContent = "先到「中转 Key」创建一个，才能开始对话。";
    hint.dataset.tone = "error";
  }
}

/* ---------- Routing ---------- */

function normalizeRoute(pathname: string): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/console") return DEFAULT_ROUTE;
  return MENU.some((item) => item.route === path) ? path : DEFAULT_ROUTE;
}

async function navigate(route: string, push: boolean): Promise<void> {
  const target = normalizeRoute(route);
  if (push && window.location.pathname.replace(/\/+$/, "") !== target) {
    window.history.pushState({}, "", target);
  }
  currentRoute = target;
  highlightMenu();
  await mountSection(target);
}

function highlightMenu(): void {
  for (const button of app.querySelectorAll<HTMLElement>("[data-route]")) {
    button.classList.toggle("is-active", button.dataset.route === currentRoute);
  }
  const item = MENU.find((entry) => entry.route === currentRoute);
  const title = app.querySelector("[data-topbar-title]");
  if (title) title.textContent = item?.title ?? "控制台";
}

function setNavOpen(open: boolean): void {
  const shell = app.querySelector(".admin-shell");
  if (!shell) return;
  shell.classList.toggle("is-nav-open", open);
  document.body.classList.toggle("nav-open", open);
  const toggle = app.querySelector<HTMLButtonElement>("[data-action='toggle-nav']");
  if (toggle) toggle.setAttribute("aria-expanded", String(open));
  const scrim = app.querySelector(".admin-scrim");
  if (scrim) scrim.setAttribute("aria-hidden", String(!open));
}

async function mountSection(route: string): Promise<void> {
  if (!content) return;
  const item = MENU.find((entry) => entry.route === route);
  document.title = `${item?.title ?? "控制台"} · API for Cursor`;

  if (route === "/chat") {
    const { mountChat } = await import("./chat");
    mountChat(content);
    return;
  }
  if (route === "/lab") {
    const { mountLab } = await import("./lab");
    mountLab(content);
    return;
  }
  const { mountManagement } = await import("./console");
  const section =
    route === "/console/relay-keys"
      ? "relay-keys"
      : route === "/console/settings"
        ? "settings"
        : route === "/console/access-logs"
          ? "access-logs"
          : "cursor-keys";
  mountManagement(content, section);
}

/* ---------- Global listeners ---------- */

function bindGlobalListeners(): void {
  if (listenersBound) return;
  listenersBound = true;

  app.addEventListener("submit", (event) => {
    const form = (event.target as HTMLElement | null)?.closest<HTMLFormElement>('form[data-form="login"]');
    if (!form) return;
    event.preventDefault();
    void submitLogin(form);
  });

  window.addEventListener("popstate", () => {
    if (session.authRequired && !session.authenticated) return;
    setNavOpen(false);
    void navigate(window.location.pathname, false);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setNavOpen(false);
  });

  window.addEventListener("resize", () => {
    if (window.matchMedia("(min-width: 821px)").matches) setNavOpen(false);
  });

  // A lapsed console session (any admin 401) drops back to the login view.
  window.addEventListener("console:auth-lost", () => {
    session = { authRequired: true, authenticated: false };
    document.body.classList.remove("nav-open");
    renderLogin();
  });

  window.addEventListener("console:password-changed", () => {
    session = { authRequired: true, authenticated: true };
    paintSignOut();
  });

  // Relay keys changed in the management view: refresh the shared selector.
  window.addEventListener("relay:changed", () => {
    void (async () => {
      await refreshRelayKeys();
      paintRelaySelector();
      if (RELAY_ROUTES.has(currentRoute)) void mountSection(currentRoute);
    })();
  });
}

/* ---------- Helpers ---------- */

function setNote(element: HTMLElement, tone: string, note: string): void {
  element.textContent = note;
  element.dataset.tone = tone;
}

function escapeOption(value: string): string {
  return value.replace(/[<>&"]/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      default:
        return "&quot;";
    }
  });
}
