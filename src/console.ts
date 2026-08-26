import { escapeAttr, escapeHtml, icon, wireCopyButtons } from "./ui";
import { THEMES, applyTheme, parseThemeId, readStoredTheme, type ThemeId } from "./theme";

export type ManagementSection = "cursor-keys" | "relay-keys" | "settings" | "access-logs";

interface CursorKey {
  id: string;
  hint: string | null;
  email: string | null;
  name: string | null;
  keyName: string | null;
  isDefault: boolean;
  relayCount: number;
  createdAt: string;
  updatedAt: string;
  key?: string;
}

interface RelayKey {
  id: string;
  cursorKeyId: string;
  name: string;
  key: string;
  hint: string | null;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface ApiError {
  error?: { message?: string };
}

interface RuntimeProbe {
  status: "up" | "down";
  durationMs: number;
  agents?: number;
  host?: string;
  port?: number;
  url?: string;
  error?: string;
}

interface RuntimeState {
  encryptionKey: { present: boolean };
  sdk: { host: string; port: number; url: string; probe: RuntimeProbe };
  relay: { host: string; port: number; currentOrigin: string };
}

interface AccessLogEntry {
  id: string;
  createdAt: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  model: string | null;
  error: string | null;
}

const ACCESS_LOG_PAGE = 50;

type Tone = "idle" | "busy" | "ok" | "error";

let boundRoot: HTMLElement | null = null;
let root: HTMLElement;
let currentSection: ManagementSection = "cursor-keys";
let cursorKeys: CursorKey[] = [];
let relayKeys: RelayKey[] = [];
let baseUrl = `${window.location.origin}/v1`;
let createOpen = false;
let runtime: RuntimeState | null = null;
let runtimeError = "";
let accessLogs: AccessLogEntry[] = [];
let accessLogsTotal = 0;
let accessLogsOffset = 0;
let accessLogsQuery = "";
let accessLogsError = "";

/** Mounts a single management section into the shell's content area. */
export function mountManagement(container: HTMLElement, section: ManagementSection): void {
  root = container;
  currentSection = section;
  createOpen = false;
  if (section === "access-logs") accessLogsOffset = 0;
  bindOnce();
  root.innerHTML = `<div class="page"><p class="console-note">加载中…</p></div>`;
  void refreshAndRender();
}

async function refreshAndRender(): Promise<void> {
  if (currentSection === "settings") await loadRuntime();
  else if (currentSection === "access-logs") await loadAccessLogs();
  else await loadData();
  renderSection();
}

async function loadData(): Promise<void> {
  const [cursorRes, relayRes] = await Promise.all([
    adminFetch("/api/admin/cursor-keys"),
    adminFetch("/api/admin/relay-keys")
  ]);
  if (!cursorRes || !relayRes) return;
  if (cursorRes.ok) {
    const payload = (await cursorRes.json()) as { keys?: CursorKey[] };
    cursorKeys = payload.keys ?? [];
  }
  if (relayRes.ok) {
    const payload = (await relayRes.json()) as { keys?: RelayKey[]; baseUrl?: string };
    relayKeys = payload.keys ?? [];
    if (payload.baseUrl) baseUrl = payload.baseUrl;
  }
}

/**
 * Wraps admin fetches: a 401 means the console session lapsed, so tell the
 * shell to show the sign-in view instead of surfacing a confusing error.
 */
async function adminFetch(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    const response = await fetch(path, { credentials: "same-origin", ...init });
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent("console:auth-lost"));
      return null;
    }
    return response;
  } catch {
    return null;
  }
}

/* ---------- Rendering ---------- */

function renderSection(): void {
  root.innerHTML =
    currentSection === "settings"
      ? settingsSection()
      : currentSection === "access-logs"
        ? accessLogsSection()
        : currentSection === "relay-keys"
          ? relayKeySection()
          : cursorKeySection();
  if (currentSection !== "settings" && currentSection !== "access-logs") wireCopyButtons(root);
}

function settingsSection(): string {
  const current = readStoredTheme();
  return `
    <div class="page page--settings">
      <header class="page-head">
        <div>
          <p class="page-kicker">STATION</p>
          <h1>设置</h1>
          <p>主题保存在这台浏览器。密码以哈希写入数据库。加密密钥只生成一次，设置页不展示明文。</p>
        </div>
      </header>

      <section class="create-panel fiducial">
        <div>
          <p class="page-kicker">DISPLAY</p>
          <h2 class="settings-subhead">主题颜色</h2>
        </div>
        <div class="theme-picker" role="radiogroup" aria-label="主题颜色">
          ${THEMES.map((theme) => themeCard(theme, current)).join("")}
        </div>
      </section>

      <form class="create-panel fiducial" data-form="change-password">
        <div>
          <p class="page-kicker">ACCESS</p>
          <h2 class="settings-subhead">后台密码</h2>
        </div>
        <div class="create-grid">
          <label class="create-field create-field--wide">
            <span>当前密码</span>
            <input class="admin-input" type="password" autocomplete="current-password" data-password-current />
          </label>
          <label class="create-field create-field--wide">
            <span>新密码</span>
            <input class="admin-input" type="password" autocomplete="new-password" minlength="8" required data-password-new />
          </label>
          <label class="create-field create-field--wide">
            <span>确认新密码</span>
            <input class="admin-input" type="password" autocomplete="new-password" minlength="8" required data-password-confirm />
          </label>
        </div>
        <p class="console-note">尚未设置密码时可留空「当前密码」。新密码至少 8 位。</p>
        <div class="create-actions">
          <button class="btn btn-primary console-btn" type="submit">保存密码</button>
        </div>
        <p class="console-note" data-note="change-password"></p>
      </form>

      ${listenSettingsMarkup()}
    </div>
  `;
}

function listenSettingsMarkup(): string {
  const sdkHost = runtime?.sdk.host ?? "127.0.0.1";
  const sdkPort = runtime?.sdk.port ?? 8792;
  const relayHost = runtime?.relay.host ?? "0.0.0.0";
  const relayPort = runtime?.relay.port ?? 5173;
  const encryption = runtime?.encryptionKey.present ? "已生成" : "未生成";
  const probe = runtime?.sdk.probe;
  const sdkState = !runtime ? "busy" : probe?.status === "up" ? "ok" : "error";
  const sdkLabel = !runtime
    ? "探测中…"
    : probe?.status === "up"
      ? `在听 ${escapeHtml(probe.host ?? sdkHost)}:${escapeHtml(String(probe.port ?? sdkPort))}`
      : probe?.error
        ? `不可达（${escapeHtml(probe.error)}）`
        : "不可达";
  const origin = runtime?.relay.currentOrigin ?? window.location.origin;
  return `
      <section class="create-panel fiducial">
        <div>
          <p class="page-kicker">CRYPTO</p>
          <h2 class="settings-subhead">加密密钥</h2>
        </div>
        <p class="console-note">用于加密 Cursor Token 与中转 Key。库中没有时首次启动会随机生成并持久化，之后不会轮换。</p>
        <p class="listen-status"><span class="status-lamp" data-tone="${runtime?.encryptionKey.present ? "ok" : "error"}"></span>${encryption}</p>
      </section>

      <form class="create-panel fiducial" data-form="sdk-listen">
        <div>
          <p class="page-kicker">SDK</p>
          <h2 class="settings-subhead">Cursor SDK</h2>
        </div>
        <p class="listen-status"><span class="status-lamp" data-tone="${sdkState}"></span>${sdkLabel}${probe && runtime ? ` · ${probe.durationMs}ms` : ""}</p>
        <div class="create-grid">
          <label class="create-field">
            <span>主机</span>
            <input class="admin-input" name="sdkListenHost" value="${escapeAttr(sdkHost)}" required data-sdk-host />
          </label>
          <label class="create-field">
            <span>端口</span>
            <input class="admin-input" name="sdkListenPort" type="number" min="1" max="65535" value="${sdkPort}" required data-sdk-port />
          </label>
        </div>
        <div class="create-actions">
          <button class="btn btn-primary console-btn" type="submit">保存并换绑</button>
        </div>
        <p class="console-note" data-note="sdk-listen"></p>
      </form>

      <form class="create-panel fiducial" data-form="relay-listen">
        <div>
          <p class="page-kicker">RELAY</p>
          <h2 class="settings-subhead">中转服务</h2>
        </div>
        <p class="console-note">当前实际 origin：<span class="admin-mono">${escapeHtml(origin)}</span></p>
        <div class="create-grid">
          <label class="create-field">
            <span>主机</span>
            <input class="admin-input" name="relayListenHost" value="${escapeAttr(relayHost)}" required data-relay-host />
          </label>
          <label class="create-field">
            <span>端口</span>
            <input class="admin-input" name="relayListenPort" type="number" min="1" max="65535" value="${relayPort}" required data-relay-port />
          </label>
        </div>
        <div class="create-actions">
          <button class="btn btn-primary console-btn" type="submit">保存并换绑</button>
        </div>
        <p class="console-note" data-note="relay-listen"></p>
      </form>
      ${runtimeError ? `<p class="console-note" data-tone="error">${escapeHtml(runtimeError)}</p>` : ""}`;
}

function accessLogsSection(): string {
  const page = Math.floor(accessLogsOffset / ACCESS_LOG_PAGE) + 1;
  const pages = Math.max(1, Math.ceil(accessLogsTotal / ACCESS_LOG_PAGE));
  const rows = accessLogs
    .map((entry) => {
      const tone = entry.status >= 400 ? "error" : entry.status >= 200 && entry.status < 300 ? "ok" : "idle";
      return `
        <tr class="admin-row">
          <td data-label="时间">${escapeHtml(formatDate(entry.createdAt))}</td>
          <td data-label="方法"><span class="admin-mono">${escapeHtml(entry.method)}</span></td>
          <td data-label="路径" class="log-path"><span class="admin-mono" title="${escapeAttr(entry.path)}">${escapeHtml(entry.path)}</span></td>
          <td data-label="状态"><span class="log-status" data-tone="${tone}">${entry.status}</span></td>
          <td data-label="耗时">${entry.durationMs}ms</td>
          <td data-label="模型">${entry.model ? escapeHtml(entry.model) : "—"}</td>
          <td data-label="错误" class="log-error">${entry.error ? escapeHtml(entry.error) : "—"}</td>
        </tr>`;
    })
    .join("");
  return `
    <div class="page page--settings">
      <header class="page-head">
        <div>
          <p class="page-kicker">TRAFFIC</p>
          <h1>访问日志</h1>
          <p>记录 <span class="admin-mono">/v1</span> 与管理接口。不保存请求体、Authorization 或密码。</p>
        </div>
      </header>
      <form class="log-search" data-form="logs-search">
        <label class="create-field create-field--wide">
          <span>搜索</span>
          <input class="admin-input" type="search" name="q" value="${escapeAttr(accessLogsQuery)}" placeholder="路径、方法、状态码、模型或错误" data-logs-q />
        </label>
        <button class="btn btn-primary console-btn" type="submit">查看</button>
      </form>
      ${accessLogsError ? `<p class="console-note" data-tone="error">${escapeHtml(accessLogsError)}</p>` : ""}
      <div class="admin-table-wrap admin-table-wrap--logs">
        <table class="admin-table admin-table--logs">
          <thead>
            <tr>
              <th>时间</th>
              <th>方法</th>
              <th>路径</th>
              <th>状态</th>
              <th>耗时</th>
              <th>模型</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr class="admin-row"><td colspan="7" class="admin-cell-dim">暂无访问日志。</td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="log-pager">
        <button class="btn console-btn" type="button" data-action="logs-prev" ${accessLogsOffset <= 0 ? "disabled" : ""}>上一页</button>
        <span class="console-note">第 ${page} / ${pages} 页 · 共 ${accessLogsTotal} 条</span>
        <button class="btn console-btn" type="button" data-action="logs-next" ${accessLogsOffset + ACCESS_LOG_PAGE >= accessLogsTotal ? "disabled" : ""}>下一页</button>
      </div>
    </div>
  `;
}

function themeCard(theme: (typeof THEMES)[number], current: ThemeId): string {
  const active = theme.id === current;
  return `
    <button
      class="theme-card${active ? " is-active" : ""}"
      type="button"
      role="radio"
      aria-checked="${active}"
      data-action="set-theme"
      data-id="${theme.id}"
    >
      <span class="theme-swatch" aria-hidden="true">
        <i style="background:${theme.swatches[0]}"></i>
        <i style="background:${theme.swatches[1]}"></i>
        <i style="background:${theme.swatches[2]}"></i>
      </span>
      <strong>${escapeHtml(theme.label)}</strong>
      <span>${escapeHtml(theme.blurb)}</span>
    </button>
  `;
}

function setTheme(id: string): void {
  const themeId = parseThemeId(id);
  if (themeId !== id) return;
  applyTheme(themeId);
  for (const card of root.querySelectorAll<HTMLElement>(".theme-card")) {
    const on = card.dataset.id === themeId;
    card.classList.toggle("is-active", on);
    card.setAttribute("aria-checked", String(on));
  }
}

function emptyState(title: string, body: string, action: string, disabled = false): string {
  return `
    <div class="empty-state">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(body)}</p>
      <button class="btn btn-primary console-btn" type="button" data-action="toggle-create" ${disabled ? "disabled" : ""}>${icon("Plus", { width: 16, height: 16 })}<span>${escapeHtml(action)}</span></button>
    </div>
  `;
}

/* ---------- Cursor keys ---------- */

function cursorKeySection(): string {
  const rows = cursorKeys.length
    ? cursorKeys.map(cursorKeyRow).join("")
    : "";
  return `
    <div class="page">
      <header class="page-head">
        <div>
          <p class="page-kicker">TOKEN</p>
          <h1>Cursor Token</h1>
          <p>上游凭证。默认 Token 给对话、实验室，以及未指定归属的中转 Key 使用。</p>
        </div>
        <button class="btn btn-primary console-btn" type="button" data-action="toggle-create" aria-expanded="${createOpen}">
          ${icon("Plus", { width: 16, height: 16 })}<span>添加 Token</span>
        </button>
      </header>

      <form class="create-panel fiducial" data-form="add-cursor-key" data-create-panel ${createOpen ? "" : "hidden"}>
        <div class="create-grid">
          <label class="create-field create-field--wide">
            <span>Cursor 用户 API Key</span>
            <input class="admin-input" type="password" autocomplete="off" spellcheck="false" placeholder="crsr_…" data-add-cursor-input />
          </label>
          <label class="admin-check create-check">
            <input type="checkbox" data-add-cursor-default />
            <span>设为默认</span>
          </label>
        </div>
        <div class="create-actions">
          <button class="btn btn-glass admin-btn" type="button" data-action="toggle-create">取消</button>
          <button class="btn btn-primary admin-btn" type="submit">添加 Token</button>
        </div>
      </form>
      <p class="console-note" data-note="add-cursor-key"></p>

      ${
        cursorKeys.length === 0
          ? emptyState("还没有 Cursor Token", "先添加一个，才能创建中转 Key 或开始对话。", "添加 Token")
          : `<div class="page-table-wrap fiducial">
        <table class="admin-table admin-table--cursor">
          <thead>
            <tr>
              <th>账户</th>
              <th>Key 名称</th>
              <th>Token</th>
              <th>中转 Key</th>
              <th>创建时间</th>
              <th>状态</th>
              <th class="admin-table-actions-col">操作</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
      }
    </div>
  `;
}

function cursorKeyRow(key: CursorKey): string {
  const email = key.email || "未绑定邮箱";
  const name = key.name || "";
  const id = escapeAttr(key.id);
  return `
    <tr class="admin-row" data-cursor-item="${id}">
      <td data-label="账户">
        <div class="admin-key-name">
          <strong>${escapeHtml(email)}</strong>
          ${name ? `<span class="admin-cell-dim">${escapeHtml(name)}</span>` : ""}
        </div>
      </td>
      <td data-label="Key 名称"><span class="admin-cell-dim">${escapeHtml(key.keyName || "—")}</span></td>
      <td data-label="Token"><code class="admin-mono-faint">${escapeHtml(maskToken(key))}</code></td>
      <td data-label="中转 Key">${key.relayCount}</td>
      <td data-label="创建时间"><span class="admin-cell-dim" title="${escapeAttr(formatDate(key.createdAt))}">${escapeHtml(formatRelative(key.createdAt))}</span></td>
      <td data-label="状态">${key.isDefault ? `<span class="admin-tag admin-tag--default">默认</span>` : `<span class="admin-cell-dim">—</span>`}</td>
      <td class="admin-table-actions" data-label="操作">
        <div class="admin-icon-bar">
          <button class="admin-icon-btn" type="button" data-action="cursor-view" data-id="${id}" title="查看详情" aria-label="查看详情">${icon("Eye", { width: 16, height: 16 })}</button>
          <button class="admin-icon-btn" type="button" data-action="cursor-test" data-id="${id}" title="测试" aria-label="测试">${icon("RefreshCw", { width: 16, height: 16 })}</button>
          <button class="admin-icon-btn" type="button" data-action="cursor-edit-toggle" data-id="${id}" title="编辑" aria-label="编辑">${icon("Pencil", { width: 16, height: 16 })}</button>
          <div class="admin-more">
            <button class="admin-icon-btn" type="button" data-action="cursor-more" data-id="${id}" title="更多操作" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false">${icon("EllipsisVertical", { width: 16, height: 16 })}</button>
            <div class="admin-more-menu" role="menu" hidden>
              ${key.isDefault ? "" : `<button type="button" role="menuitem" data-action="cursor-default" data-id="${id}">设为默认</button>`}
              <button type="button" role="menuitem" class="is-danger" data-action="cursor-delete" data-id="${id}">删除</button>
            </div>
          </div>
        </div>
      </td>
    </tr>
    <tr class="admin-detail-row" data-cursor-detail="${id}" hidden>
      <td colspan="7">
        ${cursorViewPanel(key)}
        <form class="admin-inline-form" hidden data-form="cursor-edit" data-id="${id}">
          <input class="admin-input" type="password" autocomplete="off" spellcheck="false" placeholder="新的 Cursor Token（留空则不修改）" data-edit-input />
          <label class="admin-check"><input type="checkbox" data-edit-default ${key.isDefault ? "checked disabled" : ""} /> <span>设为默认</span></label>
          <button class="btn btn-primary admin-btn" type="submit">保存修改</button>
        </form>
        <p class="console-note" data-note="cursor-${id}"></p>
      </td>
    </tr>
  `;
}

function cursorViewPanel(key: CursorKey): string {
  const rows: Array<[string, string]> = [
    ["账户邮箱", key.email || "—"],
    ["姓名", key.name || "—"],
    ["Key 名称", key.keyName || "—"],
    ["绑定中转 Key", `${key.relayCount} 个`],
    ["是否默认", key.isDefault ? "是" : "否"],
    ["标识 ID", key.id],
    ["创建时间", formatDate(key.createdAt)],
    ["更新时间", formatDate(key.updatedAt)]
  ];
  return `
    <div class="admin-view" hidden data-cursor-view="${escapeAttr(key.id)}">
      <dl class="admin-defs">
        ${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
        <div class="admin-defs-wide">
          <dt>完整 Token</dt>
          <dd data-cursor-secret="${escapeAttr(key.id)}">${secretMarkup(key)}</dd>
        </div>
      </dl>
    </div>
  `;
}

function secretMarkup(key: CursorKey): string {
  if (!key.key) {
    return `<span class="admin-cell-dim">正在读取完整 Token…</span>`;
  }
  return `
    <button class="admin-key-copy admin-key-copy--full" type="button" data-copy="${escapeAttr(key.key)}" title="复制完整 Token">
      <code>${escapeHtml(key.key)}</code>
      ${icon("Copy", { width: 14, height: 14, class: "copy-icon" })}
      ${icon("Check", { width: 14, height: 14, class: "copied-icon" })}
    </button>
  `;
}

function maskToken(key: CursorKey): string {
  if (key.key && key.key.length > 10) {
    return `${key.key.slice(0, 6)}…${key.key.slice(-4)}`;
  }
  return key.hint ? `…${key.hint}` : "••••";
}

/* ---------- Relay keys ---------- */

function relayKeySection(): string {
  const options = cursorKeys
    .map((key) => `<option value="${escapeAttr(key.id)}">${escapeHtml(key.email || key.name || key.keyName || key.id)}${key.isDefault ? "（默认）" : ""}</option>`)
    .join("");
  const canCreate = cursorKeys.length > 0;
  const rows = relayKeys.length ? relayKeys.map(relayKeyRow).join("") : "";
  return `
    <div class="page">
      <header class="page-head">
        <div>
          <p class="page-kicker">RELAY</p>
          <h1>中转 Key</h1>
          <p>发给别人用的 <code>sk-</code> Key。对方走同一地址，看不到你的 Cursor Token。</p>
        </div>
        <button class="btn btn-primary console-btn" type="button" data-action="toggle-create" aria-expanded="${createOpen}" ${canCreate ? "" : "disabled"}>
          ${icon("Plus", { width: 16, height: 16 })}<span>新建 Key</span>
        </button>
      </header>

      <div class="cmd-bar">
        <span class="cmd-prompt" aria-hidden="true">$</span>
        <span class="cmd-label">BASE</span>
        <code>${escapeHtml(baseUrl)}</code>
        <button class="cmd-copy" type="button" data-copy="${escapeAttr(baseUrl)}" title="复制地址">
          ${icon("Copy", { width: 14, height: 14, class: "copy-icon" })}
          ${icon("Check", { width: 14, height: 14, class: "copied-icon" })}
          <span>复制</span>
        </button>
      </div>

      <form class="create-panel fiducial" data-form="add-relay-key" data-create-panel ${createOpen ? "" : "hidden"}>
        <div class="create-grid">
          <label class="create-field">
            <span>Cursor Token</span>
            <select class="admin-input" data-add-relay-cursor ${canCreate ? "" : "disabled"}>${options || `<option value="">暂无 Cursor Token</option>`}</select>
          </label>
          <label class="create-field">
            <span>备注</span>
            <input class="admin-input" type="text" placeholder="例如：测试环境" data-add-relay-name />
          </label>
        </div>
        <div class="create-actions">
          <button class="btn btn-glass admin-btn" type="button" data-action="toggle-create">取消</button>
          <button class="btn btn-primary admin-btn" type="submit" ${canCreate ? "" : "disabled"}>创建 Key</button>
        </div>
      </form>
      <p class="console-note" data-note="add-relay-key"></p>

      ${
        relayKeys.length === 0
          ? emptyState(
              "还没有中转 Key",
              canCreate ? "创建一个，就可以把 Key 发给别人，不必交出 Cursor Token。" : "先添加 Cursor Token，再来创建中转 Key。",
              "新建 Key",
              !canCreate
            )
          : `<div class="page-table-wrap fiducial">
        <table class="admin-table">
          <thead>
            <tr>
              <th>备注</th>
              <th>绑定账户</th>
              <th>Key</th>
              <th>最近使用</th>
              <th class="admin-table-actions-col">操作</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
      }
    </div>
  `;
}

function relayKeyRow(key: RelayKey): string {
  const owner = cursorKeys.find((entry) => entry.id === key.cursorKeyId);
  const ownerLabel = owner ? owner.email || owner.name || owner.keyName || owner.id : key.cursorKeyId;
  const id = escapeAttr(key.id);
  const masked = `${key.key.slice(0, 7)}…${key.key.slice(-4)}`;
  return `
    <tr class="admin-row" data-relay-item="${id}">
      <td data-label="备注">
        <div class="admin-key-name">
          <strong>${escapeHtml(key.name || "未命名")}</strong>
          <span class="admin-tag ${key.enabled ? "admin-tag--on" : "admin-tag--off"}">${key.enabled ? "已启用" : "已停用"}</span>
        </div>
      </td>
      <td data-label="绑定 Token"><span class="admin-cell-dim" title="${escapeAttr(ownerLabel)}">${escapeHtml(ownerLabel)}</span></td>
      <td data-label="Key">
        <button class="admin-key-copy" type="button" data-copy="${escapeAttr(key.key)}" title="复制完整 Key">
          <code>${escapeHtml(masked)}</code>
          ${icon("Copy", { width: 14, height: 14, class: "copy-icon" })}
          ${icon("Check", { width: 14, height: 14, class: "copied-icon" })}
        </button>
      </td>
      <td data-label="最近使用"><span class="admin-cell-dim">${escapeHtml(formatRelative(key.lastUsedAt))}</span></td>
      <td class="admin-table-actions" data-label="操作">
        <div class="admin-icon-bar">
          <button class="admin-icon-btn" type="button" data-action="relay-test" data-id="${id}" title="测试" aria-label="测试">${icon("RefreshCw", { width: 16, height: 16 })}</button>
          <button class="admin-icon-btn" type="button" data-action="relay-guide" data-id="${id}" title="接入说明" aria-label="接入说明">${icon("Code2", { width: 16, height: 16 })}</button>
          <div class="admin-more">
            <button class="admin-icon-btn" type="button" data-action="relay-more" data-id="${id}" title="更多操作" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false">${icon("EllipsisVertical", { width: 16, height: 16 })}</button>
            <div class="admin-more-menu" role="menu" hidden>
              <button type="button" role="menuitem" data-action="relay-toggle" data-id="${id}">${key.enabled ? "停用" : "启用"}</button>
              <button type="button" role="menuitem" data-action="relay-regenerate" data-id="${id}">重新生成</button>
              <button type="button" role="menuitem" class="is-danger" data-action="relay-delete" data-id="${id}">删除</button>
            </div>
          </div>
        </div>
      </td>
    </tr>
    <tr class="admin-detail-row" data-relay-detail="${id}" hidden>
      <td colspan="5">
        <details class="admin-details" open>
          <summary>接入说明</summary>
          <pre class="console-snippet">${escapeHtml(curlSnippet(key.key))}</pre>
        </details>
        <p class="console-note" data-note="relay-${id}"></p>
      </td>
    </tr>
  `;
}

function curlSnippet(key: string): string {
  return [
    `curl ${baseUrl}/chat/completions \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"你好"}]}'`
  ].join("\n");
}

/* ---------- Actions ---------- */

async function addCursorKey(form: HTMLFormElement): Promise<void> {
  const input = form.querySelector<HTMLInputElement>("[data-add-cursor-input]");
  const makeDefault = form.querySelector<HTMLInputElement>("[data-add-cursor-default]")?.checked ?? false;
  const note = root.querySelector<HTMLElement>('[data-note="add-cursor-key"]');
  const cursorApiKey = input?.value.trim() ?? "";
  if (!cursorApiKey) {
    if (note) setNote(note, "error", "请先填写 Cursor 用户 API Key。");
    return;
  }
  if (note) setNote(note, "busy", "正在向 Cursor 校验该 Token…");
  const response = await adminFetch("/api/admin/cursor-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cursorApiKey, makeDefault })
  });
  if (!response) return;
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiError;
    if (note) setNote(note, "error", payload.error?.message || `Cursor 拒绝了该 Token（HTTP ${response.status}）。`);
    return;
  }
  createOpen = false;
  await reload();
}

async function editCursorKey(form: HTMLFormElement): Promise<void> {
  const id = form.dataset.id ?? "";
  const input = form.querySelector<HTMLInputElement>("[data-edit-input]");
  const defaultBox = form.querySelector<HTMLInputElement>("[data-edit-default]");
  const note = root.querySelector<HTMLElement>(`[data-note="cursor-${cssEscape(id)}"]`);
  const cursorApiKey = input?.value.trim() ?? "";
  const setDefault = Boolean(defaultBox?.checked && !defaultBox.disabled);

  const updates: Record<string, unknown> = {};
  if (cursorApiKey) updates.cursorApiKey = cursorApiKey;
  if (setDefault) updates.makeDefault = true;
  if (Object.keys(updates).length === 0) {
    if (note) setNote(note, "idle", "未做任何修改。");
    return;
  }

  if (note) setNote(note, "busy", "正在保存修改…");
  const response = await adminFetch(`/api/admin/cursor-keys/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates)
  });
  if (!response) return;
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiError;
    if (note) setNote(note, "error", payload.error?.message || `保存失败（HTTP ${response.status}）。`);
    return;
  }
  await reload();
}

async function changePassword(form: HTMLFormElement): Promise<void> {
  const current = form.querySelector<HTMLInputElement>("[data-password-current]")?.value ?? "";
  const next = form.querySelector<HTMLInputElement>("[data-password-new]")?.value ?? "";
  const confirm = form.querySelector<HTMLInputElement>("[data-password-confirm]")?.value ?? "";
  const note = root.querySelector<HTMLElement>('[data-note="change-password"]');
  if (next.length < 8) {
    if (note) setNote(note, "error", "新密码至少 8 位。");
    return;
  }
  if (next !== confirm) {
    if (note) setNote(note, "error", "两次输入的新密码不一致。");
    return;
  }
  if (note) setNote(note, "busy", "正在保存密码…");
  const response = await adminFetch("/api/admin/password", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: current, newPassword: next })
  });
  if (!response) return;
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiError;
    if (note) setNote(note, "error", payload.error?.message || `保存失败（HTTP ${response.status}）。`);
    return;
  }
  form.reset();
  window.dispatchEvent(new CustomEvent("console:password-changed"));
  if (note) setNote(note, "ok", "密码已写入数据库。之后请用新密码登录。");
}

async function loadRuntime(): Promise<void> {
  runtimeError = "";
  const response = await adminFetch("/api/admin/runtime");
  if (!response) return;
  if (!response.ok) {
    runtimeError = `无法读取运行状态（HTTP ${response.status}）。`;
    return;
  }
  runtime = (await response.json()) as RuntimeState;
}

async function loadAccessLogs(): Promise<void> {
  accessLogsError = "";
  const params = new URLSearchParams({
    limit: String(ACCESS_LOG_PAGE),
    offset: String(accessLogsOffset)
  });
  if (accessLogsQuery) params.set("q", accessLogsQuery);
  const response = await adminFetch(`/api/admin/access-logs?${params.toString()}`);
  if (!response) return;
  if (!response.ok) {
    accessLogsError = `无法读取访问日志（HTTP ${response.status}）。`;
    return;
  }
  const payload = (await response.json()) as { logs?: AccessLogEntry[]; total?: number };
  accessLogs = payload.logs ?? [];
  accessLogsTotal = payload.total ?? 0;
}

async function searchAccessLogs(form: HTMLFormElement): Promise<void> {
  accessLogsQuery = form.querySelector<HTMLInputElement>("[data-logs-q]")?.value.trim() ?? "";
  accessLogsOffset = 0;
  await refreshAndRender();
}

async function saveSdkListen(form: HTMLFormElement): Promise<void> {
  const host = form.querySelector<HTMLInputElement>("[data-sdk-host]")?.value.trim() ?? "";
  const port = Number(form.querySelector<HTMLInputElement>("[data-sdk-port]")?.value);
  const previous = runtime?.sdk;
  const note = root.querySelector<HTMLElement>('[data-note="sdk-listen"]');
  if (note) setNote(note, "busy", "正在保存…");
  const response = await adminFetch("/api/admin/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sdkListenHost: host, sdkListenPort: port })
  });
  if (!response) return;
  const payload = (await response.json().catch(() => ({}))) as ApiError & {
    sdk?: { rebind?: { ok?: boolean; error?: string } };
  };
  if (!response.ok) {
    if (note) setNote(note, "error", payload.error?.message || `保存失败（HTTP ${response.status}）。`);
    return;
  }
  const liveRebind = await rebindSdkFromBrowser(previous, { host, port });
  if (liveRebind) await new Promise((resolve) => setTimeout(resolve, 300));
  await loadRuntime();
  renderSection();
  const savedNote = root.querySelector<HTMLElement>('[data-note="sdk-listen"]');
  if (liveRebind) {
    if (savedNote) setNote(savedNote, "ok", `已保存，SDK 正在听 ${host}:${port}。`);
    return;
  }
  if (payload.sdk?.rebind && payload.sdk.rebind.ok === false) {
    if (savedNote) setNote(savedNote, "error", payload.sdk.rebind.error || "配置已保存，请重启 npm run dev。");
    return;
  }
  if (savedNote) setNote(savedNote, "error", "配置已保存，但未能换绑，请重启 npm run dev。");
}

async function saveRelayListen(form: HTMLFormElement): Promise<void> {
  const host = form.querySelector<HTMLInputElement>("[data-relay-host]")?.value.trim() ?? "";
  const port = Number(form.querySelector<HTMLInputElement>("[data-relay-port]")?.value);
  const note = root.querySelector<HTMLElement>('[data-note="relay-listen"]');
  if (note) setNote(note, "busy", "正在保存…");
  const response = await adminFetch("/api/admin/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relayListenHost: host, relayListenPort: port })
  });
  if (!response) return;
  const payload = (await response.json().catch(() => ({}))) as ApiError & {
    relay?: { rebind?: { ok?: boolean; newOrigin?: string; appliedOnNextStart?: boolean; error?: string } };
  };
  if (!response.ok) {
    if (note) setNote(note, "error", payload.error?.message || `保存失败（HTTP ${response.status}）。`);
    return;
  }
  const liveRebind = await rebindRelayFromBrowser(host, port);
  if (!(liveRebind?.ok && liveRebind.newOrigin && liveRebind.newOrigin !== window.location.origin)) {
    await loadRuntime();
  }
  renderSection();
  const savedNote = root.querySelector<HTMLElement>('[data-note="relay-listen"]');
  const newOrigin = liveRebind?.newOrigin || payload.relay?.rebind?.newOrigin;
  if (liveRebind?.ok && newOrigin && newOrigin !== window.location.origin) {
    if (savedNote) setNote(savedNote, "ok", `已换绑。请改用新地址 ${newOrigin}`);
    return;
  }
  if (liveRebind?.ok) {
    if (savedNote) setNote(savedNote, "ok", `已保存，中转正在听 ${host}:${port}。`);
    return;
  }
  if (payload.relay?.rebind && payload.relay.rebind.ok === false) {
    if (savedNote) setNote(savedNote, "error", payload.relay.rebind.error || "配置已保存，下次启动生效。");
    return;
  }
  if (savedNote) setNote(savedNote, "error", "配置已保存，下次启动生效。");
}

function browserReachableHost(host: string): string {
  return host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host.replace(/^::ffff:/, "");
}

async function rebindSdkFromBrowser(
  previous: { host: string; port: number } | undefined,
  next: { host: string; port: number }
): Promise<boolean> {
  const from = previous ?? next;
  const url = `http://${browserReachableHost(from.host)}:${from.port}/listen`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next)
    });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => ({}))) as { ok?: unknown };
    return body.ok !== false;
  } catch {
    return false;
  }
}

async function rebindRelayFromBrowser(
  host: string,
  port: number
): Promise<{ ok: boolean; newOrigin?: string } | null> {
  try {
    const response = await fetch("/__station/rebind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, port })
    });
    if (!response.ok) return { ok: false };
    const body = (await response.json().catch(() => ({}))) as { ok?: unknown; newOrigin?: unknown };
    if (body.ok !== true) return { ok: false };
    return { ok: true, newOrigin: typeof body.newOrigin === "string" ? body.newOrigin : undefined };
  } catch {
    return { ok: false };
  }
}

async function setDefaultCursor(id: string): Promise<void> {
  const response = await adminFetch(`/api/admin/cursor-keys/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ makeDefault: true })
  });
  if (response?.ok) await reload();
}

async function deleteCursor(id: string): Promise<void> {
  const key = cursorKeys.find((entry) => entry.id === id);
  const owned = key?.relayCount ?? 0;
  const confirmed = window.confirm(
    owned > 0 ? `删除该 Token 及其 ${owned} 个中转 Key？此操作不可撤销。` : "删除该 Cursor Token？"
  );
  if (!confirmed) return;
  const response = await adminFetch(`/api/admin/cursor-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (response?.ok) await reload();
}

async function testCursor(id: string): Promise<void> {
  showCursorDetail(id);
  const note = root.querySelector<HTMLElement>(`[data-note="cursor-${cssEscape(id)}"]`);
  if (note) setNote(note, "busy", "正在通过 Cursor 测试该 Token…");
  const response = await adminFetch(`/api/admin/cursor-keys/${encodeURIComponent(id)}/test`, { method: "POST" });
  if (!response || !note) return;
  await paintTestResult(note, response);
}

async function addRelayKey(form: HTMLFormElement): Promise<void> {
  const cursorKeyId = (form.querySelector("[data-add-relay-cursor]") as HTMLSelectElement | null)?.value ?? "";
  const name = form.querySelector<HTMLInputElement>("[data-add-relay-name]")?.value ?? "";
  const note = root.querySelector<HTMLElement>('[data-note="add-relay-key"]');
  if (!cursorKeyId) {
    if (note) setNote(note, "error", "请先选择一个 Cursor Token。");
    return;
  }
  if (note) setNote(note, "busy", "正在生成中转 Key…");
  const response = await adminFetch("/api/admin/relay-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cursorKeyId, name })
  });
  if (!response) return;
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiError;
    if (note) setNote(note, "error", payload.error?.message || `创建失败（HTTP ${response.status}）。`);
    return;
  }
  createOpen = false;
  await reload();
}

async function toggleRelay(id: string): Promise<void> {
  const key = relayKeys.find((entry) => entry.id === id);
  if (!key) return;
  const response = await adminFetch(`/api/admin/relay-keys/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: !key.enabled })
  });
  if (response?.ok) await reload();
}

async function regenerateRelay(id: string): Promise<void> {
  if (!window.confirm("重新生成该中转 Key？旧的 Key 会立即失效。")) return;
  const response = await adminFetch(`/api/admin/relay-keys/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ regenerate: true })
  });
  if (response?.ok) await reload();
}

async function deleteRelay(id: string): Promise<void> {
  if (!window.confirm("删除该中转 Key？")) return;
  const response = await adminFetch(`/api/admin/relay-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (response?.ok) await reload();
}

async function testRelay(id: string): Promise<void> {
  showRelayDetail(id);
  const note = root.querySelector<HTMLElement>(`[data-note="relay-${cssEscape(id)}"]`);
  if (note) setNote(note, "busy", "正在测试绑定的 Token…");
  const response = await adminFetch(`/api/admin/relay-keys/${encodeURIComponent(id)}/test`, { method: "POST" });
  if (!response || !note) return;
  await paintTestResult(note, response);
}

async function paintTestResult(note: HTMLElement, response: Response): Promise<void> {
  const payload = (await response.json().catch(() => ({}))) as ApiError & {
    ok?: boolean;
    email?: string | null;
    name?: string | null;
    keyName?: string | null;
    modelCount?: number | null;
  };
  if (!response.ok) {
    setNote(note, "error", payload.error?.message || `测试失败（HTTP ${response.status}）。`);
    return;
  }
  const owner = payload.email || payload.name || payload.keyName || "该 Token";
  const models = typeof payload.modelCount === "number" ? ` · ${payload.modelCount} 个模型` : "";
  setNote(note, "ok", `正常 —— ${owner}${models}。`);
}

/**
 * Re-reads data, re-renders the current section, and notifies the shell so the
 * shared relay-key selector stays in sync after a mutation.
 */
async function reload(): Promise<void> {
  await loadData();
  renderSection();
  window.dispatchEvent(new CustomEvent("relay:changed"));
}

/* ---------- Event wiring ---------- */

function bindOnce(): void {
  if (boundRoot === root) return;
  boundRoot = root;

  root.addEventListener("submit", (event) => {
    const form = (event.target as HTMLElement | null)?.closest<HTMLFormElement>("form[data-form]");
    if (!form) return;
    event.preventDefault();
    switch (form.dataset.form) {
      case "add-cursor-key":
        void addCursorKey(form);
        break;
      case "cursor-edit":
        void editCursorKey(form);
        break;
      case "add-relay-key":
        void addRelayKey(form);
        break;
      case "change-password":
        void changePassword(form);
        break;
      case "sdk-listen":
        void saveSdkListen(form);
        break;
      case "relay-listen":
        void saveRelayListen(form);
        break;
      case "logs-search":
        void searchAccessLogs(form);
        break;
    }
  });

  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest("[data-action='relay-more']") && !target?.closest("[data-action='cursor-more']") && !target?.closest(".admin-more-menu")) {
      closeAllMoreMenus();
    }

    const trigger = target?.closest<HTMLElement>("[data-action]");
    if (!trigger) return;
    const id = trigger.dataset.id ?? "";
    switch (trigger.dataset.action) {
      case "cursor-default":
        void setDefaultCursor(id);
        break;
      case "cursor-view":
        closeAllMoreMenus();
        toggleCursorPanel(id, "view");
        break;
      case "cursor-edit-toggle":
        toggleCursorPanel(id, "edit");
        break;
      case "cursor-test":
        void testCursor(id);
        break;
      case "cursor-delete":
        void deleteCursor(id);
        break;
      case "cursor-more":
        toggleMoreMenu(trigger);
        break;
      case "relay-test":
        void testRelay(id);
        break;
      case "relay-toggle":
        closeAllMoreMenus();
        void toggleRelay(id);
        break;
      case "relay-regenerate":
        closeAllMoreMenus();
        void regenerateRelay(id);
        break;
      case "relay-guide":
        toggleRelayDetail(id);
        break;
      case "relay-delete":
        closeAllMoreMenus();
        void deleteRelay(id);
        break;
      case "relay-more":
        toggleMoreMenu(trigger);
        break;
      case "toggle-create":
        toggleCreatePanel();
        break;
      case "set-theme":
        setTheme(id);
        break;
      case "logs-prev":
        if (accessLogsOffset >= ACCESS_LOG_PAGE) {
          accessLogsOffset -= ACCESS_LOG_PAGE;
          void refreshAndRender();
        }
        break;
      case "logs-next":
        if (accessLogsOffset + ACCESS_LOG_PAGE < accessLogsTotal) {
          accessLogsOffset += ACCESS_LOG_PAGE;
          void refreshAndRender();
        }
        break;
    }
  });

  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeAllMoreMenus();
    if (createOpen) toggleCreatePanel();
  });
}

function toggleCursorPanel(id: string, which: "view" | "edit"): void {
  const detail = root.querySelector<HTMLElement>(`[data-cursor-detail="${cssEscape(id)}"]`);
  const view = root.querySelector<HTMLElement>(`[data-cursor-view="${cssEscape(id)}"]`);
  const edit = root.querySelector<HTMLFormElement>(`form[data-form="cursor-edit"][data-id="${cssEscape(id)}"]`);
  if (!detail) return;

  if (which === "view" && view) {
    const opening = view.hidden;
    if (edit) edit.hidden = true;
    view.hidden = !opening;
    detail.hidden = view.hidden;
    if (opening) void revealCursorKey(id);
    return;
  }

  if (which === "edit" && edit) {
    const opening = edit.hidden;
    if (view) view.hidden = true;
    edit.hidden = !opening;
    detail.hidden = edit.hidden;
    if (!edit.hidden) edit.querySelector<HTMLInputElement>("[data-edit-input]")?.focus();
  }
}

async function revealCursorKey(id: string): Promise<void> {
  const entry = cursorKeys.find((key) => key.id === id);
  const slot = root.querySelector<HTMLElement>(`[data-cursor-secret="${cssEscape(id)}"]`);
  if (!entry || !slot) return;
  if (entry.key) {
    slot.innerHTML = secretMarkup(entry);
    wireCopyButtons(slot);
    return;
  }

  slot.innerHTML = `<span class="admin-cell-dim">正在读取完整 Token…</span>`;
  const response = await adminFetch(`/api/admin/cursor-keys/${encodeURIComponent(id)}`);
  if (!response) return;
  if (!response.ok) {
    slot.innerHTML = `<span class="admin-cell-dim">无法读取完整 Token（HTTP ${response.status}）。</span>`;
    return;
  }
  const payload = (await response.json()) as { key?: { key?: string } };
  const fullKey = payload.key?.key;
  if (!fullKey) {
    slot.innerHTML = `<span class="admin-cell-dim">该记录没有可显示的 Token。</span>`;
    return;
  }
  entry.key = fullKey;
  slot.innerHTML = secretMarkup(entry);
  wireCopyButtons(slot);
}

function showCursorDetail(id: string): void {
  const detail = root.querySelector<HTMLElement>(`[data-cursor-detail="${cssEscape(id)}"]`);
  if (detail) detail.hidden = false;
}

function toggleRelayDetail(id: string): void {
  const row = root.querySelector<HTMLElement>(`[data-relay-detail="${cssEscape(id)}"]`);
  if (row) row.hidden = !row.hidden;
}

function showRelayDetail(id: string): void {
  const row = root.querySelector<HTMLElement>(`[data-relay-detail="${cssEscape(id)}"]`);
  if (row) row.hidden = false;
}

function toggleMoreMenu(trigger: HTMLElement): void {
  const wrap = trigger.closest(".admin-more");
  if (!wrap) return;
  const wasOpen = wrap.classList.contains("is-open");
  closeAllMoreMenus();
  if (wasOpen) return;
  wrap.classList.add("is-open");
  trigger.setAttribute("aria-expanded", "true");
  const menu = wrap.querySelector<HTMLElement>(".admin-more-menu");
  if (menu) menu.hidden = false;
}

function closeAllMoreMenus(): void {
  if (!root) return;
  for (const wrap of root.querySelectorAll(".admin-more.is-open")) {
    wrap.classList.remove("is-open");
    wrap.querySelector("[aria-haspopup='menu']")?.setAttribute("aria-expanded", "false");
    const menu = wrap.querySelector<HTMLElement>(".admin-more-menu");
    if (menu) menu.hidden = true;
  }
}

function toggleCreatePanel(): void {
  createOpen = !createOpen;
  const panel = root.querySelector<HTMLElement>("[data-create-panel]");
  for (const button of root.querySelectorAll<HTMLElement>("[data-action='toggle-create']")) {
    button.setAttribute("aria-expanded", String(createOpen));
  }
  if (!panel) return;
  panel.hidden = !createOpen;
  if (createOpen) {
    panel.querySelector<HTMLElement>("input, select")?.focus();
  }
}

/* ---------- Helpers ---------- */

function setNote(element: HTMLElement, tone: Tone, note: string): void {
  element.textContent = note;
  element.dataset.tone = tone;
}

function formatRelative(value: string | null): string {
  if (!value) return "未使用";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const delta = Date.now() - date.getTime();
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return date.toLocaleDateString();
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function cssEscape(value: string): string {
  const globalCss = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
  if (globalCss?.escape) return globalCss.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
