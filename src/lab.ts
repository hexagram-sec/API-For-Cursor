import { relayAuthHeaders, relayBaseUrl, hasRelayKey, selectedRelayId } from "./relay-store";
import { escapeAttr, escapeHtml, icon } from "./ui";
import {
  DEFAULT_PROBE_CONCURRENCY,
  DEFAULT_PROBE_PROMPT,
  MAX_PROBE_CONCURRENCY,
  clampConcurrency,
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
  restoreModelCheck
} from "./model-status";

let root: HTMLElement;
let models: ProbeModel[] = [];
let selected = new Set<string>();
let prompt = DEFAULT_PROBE_PROMPT;
let concurrency = DEFAULT_PROBE_CONCURRENCY;
let running = false;
let abort: AbortController | null = null;
// Lab probes `/v1/models` with the relay key chosen in the shell sidebar.
// `loadFailed` distinguishes a failed/empty load from "no relay key selected".
let loadFailed = false;
let statusListenerBound = false;

export function mountLab(container: HTMLElement): void {
  root = container;
  bindStatusListener();
  if (running) {
    render();
    return;
  }
  void bootstrap();
}

function bindStatusListener(): void {
  if (statusListenerBound) return;
  statusListenerBound = true;
  window.addEventListener(MODEL_STATUS_CHANGED, () => {
    if (labViewActive()) paintProgress();
  });
}

function labViewActive(): boolean {
  return Boolean(root?.querySelector("[data-lab-status]"));
}

async function bootstrap(): Promise<void> {
  render();
  await loadModels();
}

async function loadModels(): Promise<void> {
  if (!hasRelayKey()) {
    models = [];
    loadFailed = true;
    render();
    return;
  }
  try {
    const response = await fetch(`${relayBaseUrl()}/models`, { credentials: "same-origin", headers: relayAuthHeaders() });
    if (!response.ok) {
      models = [];
      loadFailed = true;
      render();
      return;
    }
    models = modelsFromListPayload(await response.json());
    loadFailed = false;
    if (selected.size === 0) selected = new Set(models.map((model) => model.id));
    selected = new Set([...selected].filter((id) => models.some((model) => model.id === id)));
    render();
  } catch {
    models = [];
    loadFailed = true;
    render();
  }
}

function render(): void {
  const counts = tally();
  root.innerHTML = `
    <div class="page page--lab">
      <header class="page-head">
        <div>
          <p class="page-kicker">PROBE</p>
          <h1>实验室</h1>
          <p>用当前工作端口调用 <code>/v1/chat/completions</code>，并行探测模型能不能正常响应。</p>
        </div>
        <span class="console-pill" data-lab-status data-tone="${escapeAttr(statusTone())}">${escapeHtml(statusLabel())}</span>
      </header>
      <p class="console-note" data-lab-note data-tone="${escapeAttr(statusTone())}">${escapeHtml(statusNote())}</p>
      <section class="lab-panel lab-panel--config">
        <label class="console-field">
          <span>提示词</span>
          <textarea data-lab-prompt rows="3">${escapeHtml(prompt)}</textarea>
        </label>
        <label class="console-field lab-concurrency">
          <span>并发数</span>
          <input type="number" min="1" max="${MAX_PROBE_CONCURRENCY}" step="1" value="${concurrency}" ${running ? "disabled" : ""} data-lab-concurrency />
        </label>
        <div class="console-actions">
          <button class="btn btn-primary console-btn" type="button" data-lab-run ${runDisabled() ? "disabled" : ""}>
            ${icon("Zap", { width: 16, height: 16 })}
            <span>探测所选</span>
          </button>
          <button class="btn btn-glass console-btn" type="button" data-lab-stop ${running ? "" : "disabled"}>
            <span>停止</span>
          </button>
          <button class="btn btn-glass console-btn" type="button" data-lab-reload ${running ? "disabled" : ""}>
            ${icon("RefreshCw", { width: 16, height: 16 })}
            <span>重新加载模型</span>
          </button>
        </div>
      </section>

      <section class="lab-panel lab-panel--models">
        <div class="lab-panel-head">
          <h2>模型</h2>
          <p data-lab-selected-count>${models.length ? `已选择 ${selected.size} / ${models.length}` : "尚未加载模型。"}</p>
        </div>
        <div class="lab-select-actions">
          <button class="btn btn-glass console-btn" type="button" data-lab-all ${models.length ? "" : "disabled"}>全选</button>
          <button class="btn btn-glass console-btn" type="button" data-lab-none ${models.length ? "" : "disabled"}>全不选</button>
        </div>
        <div class="lab-models" data-lab-models>${modelListMarkup()}</div>
      </section>

      <section class="lab-panel lab-panel--results">
        <div class="lab-panel-head">
          <h2>结果</h2>
          <p data-lab-result-summary>${counts.ok} 个通过 · ${counts.error} 个失败 · 剩余 ${counts.running + counts.queued} 个</p>
        </div>
        <div class="lab-results" data-lab-results>${resultsMarkup()}</div>
      </section>
    </div>
  `;
  bind();
}

function modelListMarkup(): string {
  if (!models.length) {
    return `<p class="lab-empty">尚未加载模型。</p>`;
  }
  return models
    .map((model) => {
      const outcome = modelOutcome(model.id, selectedRelayId());
      const checked = selected.has(model.id) ? "checked" : "";
      const badge = outcome
        ? `<span class="lab-badge lab-badge--${escapeAttr(outcome.status)}">${escapeHtml(outcomeBadge(outcome))}</span>`
        : `<span class="lab-badge lab-badge--idle">未测</span>`;
      return `
        <label class="lab-model">
          <input type="checkbox" value="${escapeAttr(model.id)}" ${checked} ${running ? "disabled" : ""} />
          <span>
            <strong>${escapeHtml(model.name)}</strong>
            <code>${escapeHtml(model.id)}</code>
          </span>
          ${badge}
        </label>
      `;
    })
    .join("");
}

function resultsMarkup(): string {
  const rows = models
    .map((model) => modelOutcome(model.id, selectedRelayId()))
    .filter((outcome): outcome is ProbeOutcome => Boolean(outcome));
  if (!rows.length) {
    return `<p class="lab-empty">还没有测试记录。探测一次后，实验室和对话都会显示这次结果。</p>`;
  }
  return `
    <table class="lab-table">
      <thead>
        <tr>
          <th>模型</th>
          <th>状态</th>
          <th>HTTP</th>
          <th>耗时</th>
          <th>详情</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => resultRow(row)).join("")}
      </tbody>
    </table>
  `;
}

function resultRow(row: ProbeOutcome): string {
  const detail = row.status === "ok" ? row.reply || "" : row.error || row.status;
  return `
    <tr class="lab-row lab-row--${escapeAttr(row.status)}">
      <td data-label="模型"><code>${escapeHtml(row.model)}</code></td>
      <td data-label="状态"><span class="lab-badge lab-badge--${escapeAttr(row.status)}">${escapeHtml(outcomeBadge(row))}</span></td>
      <td data-label="HTTP">${row.httpStatus ?? "—"}</td>
      <td data-label="耗时">${typeof row.ms === "number" ? `${row.ms} ms` : "—"}</td>
      <td class="lab-detail" data-label="详情">${escapeHtml(detail)}</td>
    </tr>
  `;
}

function bind(): void {
  required<HTMLTextAreaElement>("[data-lab-prompt]").addEventListener("input", (event) => {
    prompt = (event.target as HTMLTextAreaElement).value;
  });
  required<HTMLInputElement>("[data-lab-concurrency]").addEventListener("input", (event) => {
    concurrency = clampConcurrency((event.target as HTMLInputElement).value);
  });
  required<HTMLInputElement>("[data-lab-concurrency]").addEventListener("change", (event) => {
    concurrency = clampConcurrency((event.target as HTMLInputElement).value);
    (event.target as HTMLInputElement).value = String(concurrency);
  });
  required<HTMLButtonElement>("[data-lab-run]").addEventListener("click", () => void runSelected());
  required<HTMLButtonElement>("[data-lab-stop]").addEventListener("click", () => stop());
  required<HTMLButtonElement>("[data-lab-reload]").addEventListener("click", () => void loadModels());
  required<HTMLButtonElement>("[data-lab-all]").addEventListener("click", () => {
    selected = new Set(models.map((model) => model.id));
    render();
  });
  required<HTMLButtonElement>("[data-lab-none]").addEventListener("click", () => {
    selected = new Set();
    render();
  });
  for (const input of root.querySelectorAll<HTMLInputElement>(".lab-model input")) {
    input.addEventListener("change", () => {
      if (input.checked) selected.add(input.value);
      else selected.delete(input.value);
      const count = required("[data-lab-selected-count]");
      count.textContent = `已选择 ${selected.size} / ${models.length}`;
      required<HTMLButtonElement>("[data-lab-run]").disabled = runDisabled();
    });
  }
}

async function runSelected(): Promise<void> {
  const ids = models.map((model) => model.id).filter((id) => selected.has(id));
  if (!ids.length || running) return;
  const text = prompt.trim() || DEFAULT_PROBE_PROMPT;
  prompt = text;
  concurrency = clampConcurrency(required<HTMLInputElement>("[data-lab-concurrency]").value);
  running = true;
  const controller = new AbortController();
  abort = controller;
  const signal = controller.signal;
  const relayId = selectedRelayId();
  for (const id of ids) markModelCheck(id, "queued", relayId);
  render();
  await runWithConcurrency(
    ids,
    concurrency,
    async (id) => {
      if (signal.aborted) {
        restoreModelCheck(id, relayId);
        paintProgress();
        return;
      }
      markModelCheck(id, "running", relayId);
      paintProgress();
      const outcome = await probeOne(id, text, signal);
      if (outcome.status === "cancelled") restoreModelCheck(id, relayId);
      else recordModelCheck(outcome, relayId);
      paintProgress();
    },
    signal
  );
  for (const id of ids) {
    const outcome = modelOutcome(id, relayId);
    if (outcome?.status === "queued" || outcome?.status === "running") restoreModelCheck(id, relayId);
  }
  running = false;
  abort = null;
  if (labViewActive()) render();
}

function paintProgress(): void {
  if (!labViewActive()) return;
  const counts = tally();
  const pill = root.querySelector("[data-lab-status]");
  if (pill) {
    pill.textContent = statusLabel();
    (pill as HTMLElement).dataset.tone = statusTone();
  }
  const note = root.querySelector("[data-lab-note]");
  if (note) {
    note.textContent = statusNote();
    (note as HTMLElement).dataset.tone = statusTone();
  }
  const summary = root.querySelector("[data-lab-result-summary]");
  if (summary) summary.textContent = `${counts.ok} 个通过 · ${counts.error} 个失败 · 剩余 ${counts.running + counts.queued} 个`;
  const results = root.querySelector("[data-lab-results]");
  if (results) results.innerHTML = resultsMarkup();
  const modelList = root.querySelector("[data-lab-models]");
  if (modelList) modelList.innerHTML = modelListMarkup();
}

function stop(): void {
  abort?.abort();
}

async function probeOne(model: string, text: string, signal: AbortSignal): Promise<ProbeOutcome> {
  return probeModel(model, text, signal, relayAuthHeaders());
}

function tally(): Record<ProbeOutcome["status"], number> {
  const counts = { queued: 0, running: 0, ok: 0, error: 0, cancelled: 0 };
  for (const model of models) {
    const outcome = modelOutcome(model.id, selectedRelayId());
    if (outcome) counts[outcome.status] += 1;
  }
  return counts;
}

function runDisabled(): boolean {
  return running || selected.size === 0 || models.length === 0;
}

function statusTone(): string {
  if (running) return "busy";
  const counts = tally();
  if (counts.error) return "error";
  if (counts.ok) return "ok";
  return loadFailed ? "error" : "idle";
}

function statusLabel(): string {
  if (running) return "探测中";
  const counts = tally();
  if (counts.error) return "存在失败";
  if (counts.ok) return "已通过";
  return loadFailed ? "无可用 Key" : "就绪";
}

function statusNote(): string {
  if (running) return `正在并行运行最多 ${concurrency} 个探测。`;
  if (!hasRelayKey()) {
    return "请先在左侧选择一个中转 Key（或到「中转 Key 管理」创建）。";
  }
  if (loadFailed || models.length === 0) {
    return "无法通过所选中转 Key 获取模型列表，请确认该 Key 是否有效。";
  }
  const counts = tally();
  if (counts.error) return "最近一次探测有失败。展开失败行可查看 SDK 错误。";
  if (counts.ok && !counts.queued && !counts.running) return "显示最近一次探测结果。对话里的模型状态与此相同。";
  return `来自 GET /v1/models 的 ${models.length} 个模型，最多同时运行 ${concurrency} 个。`;
}

function outcomeBadge(outcome: ProbeOutcome): string {
  if (outcome.status === "ok") return "可用";
  if (outcome.status === "error") return "失败";
  if (outcome.status === "running" || outcome.status === "queued") return "检测中";
  return "未测";
}

function required<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Lab markup is missing ${selector}`);
  return found;
}
