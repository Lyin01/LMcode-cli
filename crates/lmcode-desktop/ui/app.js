// LMcode desktop front end — minimal chat UI over the Tauri IPC bridge.
//
// Uses the global Tauri API (withGlobalTauri) so no npm build step is needed.
// The bridge is guarded so the page can also be opened as a static preview
// (headless checks, plain browsers) without throwing.

const tauri = window.__TAURI__ ?? null;

const invoke = (command, args) => {
  if (!tauri?.core?.invoke) {
    console.warn(`Tauri bridge unavailable; ignoring invoke("${command}")`);
    return Promise.reject(new Error("Tauri bridge unavailable"));
  }
  return tauri.core.invoke(command, args);
};

const listen = (event, handler) => {
  if (!tauri?.event?.listen) {
    return Promise.resolve(() => {});
  }
  return tauri.event.listen(event, handler);
};

const transcript = document.getElementById("transcript");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const input = document.getElementById("input");
const composer = document.getElementById("composer");
const approval = document.getElementById("approval");
const approvalName = document.getElementById("approval-name");
const approvalArgs = document.getElementById("approval-args");

let currentAssistant = null;
let currentThink = null;
let modelLabel = "";
let currentSession = "";

function scrollToBottom() {
  transcript.scrollTop = transcript.scrollHeight;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inlineRich(value) {
  return value
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

// Tiny markdown subset: fenced code blocks, inline code, bold.
function renderRich(text) {
  const lines = text.split("\n");
  let html = "";
  let fence = null;
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (fence === null) {
        fence = [];
      } else {
        html += `<pre class="code-block"><code>${escapeHtml(fence.join("\n"))}</code></pre>`;
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      fence.push(line);
      continue;
    }
    html += `<div class="line">${inlineRich(escapeHtml(line)) || "&nbsp;"}</div>`;
  }
  if (fence !== null) {
    html += `<pre class="code-block"><code>${escapeHtml(fence.join("\n"))}</code></pre>`;
  }
  return html;
}

function relTime(value) {
  const stamp = Date.parse(value || "");
  if (Number.isNaN(stamp)) return "";
  const seconds = Math.max(0, (Date.now() - stamp) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前`;
  return (value || "").slice(0, 10);
}

function updateStatusTitle(text) {
  const node = document.getElementById("status-title");
  if (node) node.textContent = text || "";
}

// Time-of-day salutation (ported from the legacy renderer's lib/greeting.ts).
function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 13) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

// Welcome screen, ported from the legacy renderer's AgentWelcome component.
function showWelcome() {
  transcript.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "welcome";
  wrap.id = "welcome";
  wrap.innerHTML = `
    <div class="welcome-tile">
      <svg class="icon" style="width:22px;height:22px"><use href="#i-sparkles" /></svg>
    </div>
    <div class="welcome-title">${greeting()}，今天想做什么？</div>
    <div class="welcome-sub">LMCODE · 智能工程 AI Agent</div>
  `;
  transcript.appendChild(wrap);
}

function addBlock(className, text) {
  const node = document.createElement("div");
  node.className = className;
  if (text) node.textContent = text;
  transcript.appendChild(node);
  scrollToBottom();
  return node;
}

function appendText(node, text) {
  node.dataset.raw = (node.dataset.raw || "") + text;
  node.innerHTML = renderRich(node.dataset.raw);
  scrollToBottom();
}

function addRendered(className, text) {
  const node = addBlock(className, "");
  node.dataset.raw = text;
  node.innerHTML = renderRich(text);
  return node;
}

function addUser(text, images = []) {
  const node = addRendered("msg user", text);
  if (images.length) {
    const row = document.createElement("div");
    row.className = "msg-images";
    for (const path of images) {
      const img = document.createElement("img");
      img.className = "msg-image";
      img.src = window.__TAURI__.core.convertFileSrc(path);
      row.appendChild(img);
    }
    node.appendChild(row);
  }
  currentAssistant = null;
  currentThink = null;
}

function ensureAssistant() {
  if (!currentAssistant) currentAssistant = addBlock("msg assistant");
  return currentAssistant;
}

function ensureThink() {
  if (!currentThink) currentThink = addBlock("msg think");
  return currentThink;
}

function addTool(name, args) {
  const node = addBlock("msg tool");
  node.innerHTML = "";
  const title = document.createElement("span");
  title.className = "tool-name";
  title.textContent = name;
  const detail = document.createElement("span");
  detail.className = "tool-args";
  detail.textContent = args.length > 200 ? args.slice(0, 200) + "…" : args;
  node.appendChild(title);
  node.appendChild(detail);
  currentAssistant = null;
  currentThink = null;
  return node;
}

function markTool(name, ok, result) {
  const marker = document.createElement("span");
  marker.className = ok ? "tool-ok" : "tool-fail";
  marker.textContent = ok ? " ✓" : " ✗";
  const nodes = transcript.querySelectorAll(".msg.tool");
  if (nodes.length > 0) {
    const last = nodes[nodes.length - 1];
    if (last.querySelector(".tool-name").textContent.includes(name)) {
      last.appendChild(marker);
      if (result && result.length > 0) {
        const pre = document.createElement("pre");
        pre.className = "tool-result";
        pre.textContent = result.length > 1200 ? result.slice(0, 1200) + "…" : result;
        last.appendChild(pre);
      }
      scrollToBottom();
    }
  }
}

function setStatus(kind, text) {
  statusDot.className = "dot " + kind;
  statusText.textContent = text;
}

function showApproval(name, args) {
  approvalName.textContent = name;
  approvalArgs.textContent = args;
  approval.classList.remove("hidden");
}

function hideApproval() {
  approval.classList.add("hidden");
}

// --- Session sidebar -------------------------------------------------------

const sessionList = document.getElementById("session-list");
const settingsPanel = document.getElementById("settings");
const settingsSession = document.getElementById("settings-session");
const settingsCwd = document.getElementById("settings-cwd");
const modelSelect = document.getElementById("model-select");

async function refreshSessions() {
  try {
    const sessions = await invoke("list_sessions");
    const groupCount = document.getElementById("group-count");
    if (groupCount) groupCount.textContent = String(sessions.length);
    renderSessions(sessions);
  } catch (error) {
    console.error("list_sessions failed:", error);
  }
}

function renderSessions(sessions) {
  sessionList.innerHTML = "";
  for (const session of sessions) {
    const item = document.createElement("li");
    item.className =
      "session-item" + (session.id === currentSession ? " active" : "");
    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = session.title || session.id.slice(0, 8);
    const meta = document.createElement("div");
    meta.className = "session-meta";
    meta.textContent = `${session.model} · ${relTime(session.updatedAt)}`;
    item.appendChild(title);
    item.appendChild(meta);
    item.addEventListener("click", () => resumeSession(session.id));
    sessionList.appendChild(item);
  }
}

async function resumeSession(id) {
  try {
    const history = await invoke("resume_session", { id });
    transcript.innerHTML = "";
    currentAssistant = null;
    currentThink = null;
    for (const message of history) {
      if (message.role === "user") addRendered("msg user", message.text);
      else if (message.role === "assistant")
        addRendered("msg assistant", message.text);
      else addBlock("msg tool", message.text);
    }
    const firstUser = history.find((message) => message.role === "user");
    updateStatusTitle(firstUser ? firstUser.text.slice(0, 60) : "");
    currentSession = id;
    await refreshSessions();
  } catch (error) {
    addBlock("msg error", "resume failed: " + error);
  }
}

document.getElementById("new-session-btn").addEventListener("click", async () => {
  try {
    await invoke("new_session");
    showWelcome();
    currentAssistant = null;
    currentThink = null;
    updateStatusTitle("");
  } catch (error) {
    addBlock("msg error", "new session failed: " + error);
  }
});

// --- Settings drawer -------------------------------------------------------

// Fill the composer's model picker (and refresh it whenever settings open).
async function loadModels() {
  try {
    const payload = await invoke("get_settings");
    settingsSession.textContent = payload.session ? payload.session.slice(-8) : "—";
    settingsCwd.textContent = payload.cwd || "—";
    const cwdChip = document.getElementById("composer-cwd");
    if (cwdChip && payload.cwd) cwdChip.textContent = payload.cwd;
    const cwdStatus = document.getElementById("status-cwd");
    if (cwdStatus && payload.cwd) cwdStatus.textContent = payload.cwd;
    const groupName = document.getElementById("group-name");
    if (groupName && payload.cwd) {
      const parts = payload.cwd.split(/[\\/]/).filter(Boolean);
      groupName.textContent = parts[parts.length - 1] || payload.cwd;
    }
    modelSelect.innerHTML = "";
    for (const model of payload.models) {
      const option = document.createElement("option");
      option.value = model.alias;
      option.textContent = model.displayName;
      if (model.displayName === payload.model) option.selected = true;
      modelSelect.appendChild(option);
    }
  } catch (error) {
    addBlock("msg error", "settings failed: " + error);
  }
}

// Populate the model picker at startup so the composer card is complete.
void loadModels();
showWelcome();

document.getElementById("settings-btn").addEventListener("click", async () => {
  await loadModels();
  settingsPanel.classList.remove("hidden");
});

modelSelect.addEventListener("change", async () => {
  settingsPanel.classList.add("hidden");
  try {
    await invoke("set_model", { alias: modelSelect.value });
  } catch (error) {
    addBlock("msg error", "model switch failed: " + error);
  }
});

document.getElementById("settings-close").addEventListener("click", () => {
  settingsPanel.classList.add("hidden");
});

// --- Memory browser --------------------------------------------------------

const memoryPanel = document.getElementById("memory");
const memoryList = document.getElementById("memory-list");
const memorySearch = document.getElementById("memory-search");

let memoCache = [];

async function refreshMemos() {
  try {
    memoCache = await invoke("list_memos");
    renderMemos();
  } catch (error) {
    console.error("list_memos failed:", error);
  }
}

function renderMemos() {
  const query = memorySearch.value.trim().toLowerCase();
  memoryList.innerHTML = "";
  for (const memo of memoCache) {
    const haystack =
      `${memo.userNeed} ${memo.tags.join(" ")} ${memo.kind}`.toLowerCase();
    if (query && !haystack.includes(query)) continue;
    const item = document.createElement("li");
    item.className = "memo-item";
    const head = document.createElement("div");
    head.className = "memo-head";
    const badge = document.createElement("span");
    badge.className = `memo-kind memo-kind-${memo.kind}`;
    badge.textContent = memo.kind;
    const stamp = document.createElement("span");
    stamp.className = "memo-time";
    stamp.textContent = new Date(memo.recordedAt).toLocaleString();
    const remove = document.createElement("button");
    remove.className = "memo-delete";
    remove.textContent = "✕";
    remove.title = "Delete memo";
    remove.addEventListener("click", async () => {
      try {
        await invoke("delete_memo", { id: memo.id });
        memoCache = memoCache.filter((entry) => entry.id !== memo.id);
        renderMemos();
      } catch (error) {
        console.error("delete_memo failed:", error);
      }
    });
    head.append(badge, stamp, remove);
    const need = document.createElement("div");
    need.className = "memo-need";
    need.textContent = memo.userNeed;
    const tags = document.createElement("div");
    tags.className = "memo-tags";
    tags.textContent = memo.tags.map((tag) => `#${tag}`).join(" ");
    item.append(head, need, tags);
    memoryList.appendChild(item);
  }
  if (memoryList.children.length === 0) {
    const empty = document.createElement("li");
    empty.className = "memo-empty";
    empty.textContent = memoCache.length === 0 ? "no memos yet" : "no matches";
    memoryList.appendChild(empty);
  }
}

document.getElementById("memory-btn").addEventListener("click", async () => {
  memorySearch.value = "";
  memoryPanel.classList.remove("hidden");
  await refreshMemos();
});

memorySearch.addEventListener("input", renderMemos);

document.getElementById("memory-close").addEventListener("click", () => {
  memoryPanel.classList.add("hidden");
});

// --- Git review ------------------------------------------------------------

const gitPanel = document.getElementById("git");
const gitList = document.getElementById("git-list");
const gitDiff = document.getElementById("git-diff");
const gitSummary = document.getElementById("git-summary");

let gitChanges = [];
let gitSelected = null;

const GIT_LABELS = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflicted",
  "?": "untracked",
  "!": "ignored",
};

function changeLabel(change) {
  if (change.index === "?" && change.worktree === "?") return "untracked";
  const letter = change.worktree !== " " ? change.worktree : change.index;
  return GIT_LABELS[letter] ?? letter;
}

async function refreshGit() {
  try {
    gitChanges = await invoke("git_status");
    gitSummary.textContent = `${gitChanges.length} change(s)`;
    renderGitList();
  } catch (error) {
    gitDiff.textContent = `git status failed: ${String(error)}`;
  }
}

function renderGitList() {
  gitList.innerHTML = "";
  for (const change of gitChanges) {
    const item = document.createElement("li");
    item.className = "git-item" + (change.path === gitSelected ? " active" : "");
    const label = document.createElement("span");
    label.className = `git-label git-label-${changeLabel(change).replace(/\s+/g, "-")}`;
    label.textContent = changeLabel(change);
    const path = document.createElement("span");
    path.className = "git-path";
    path.textContent = change.path;
    item.append(label, path);
    item.addEventListener("click", () => selectGitFile(change));
    gitList.appendChild(item);
  }
  if (gitList.children.length === 0) {
    const empty = document.createElement("li");
    empty.className = "memo-empty";
    empty.textContent = "working tree clean";
    gitList.appendChild(empty);
  }
}

function renderGitDiff(text) {
  gitDiff.innerHTML = "";
  for (const line of text.split("\n")) {
    const span = document.createElement("span");
    if (line.startsWith("@@")) span.className = "diff-hunk";
    else if (line.startsWith("+++") || line.startsWith("---")) span.className = "diff-head";
    else if (line.startsWith("+")) span.className = "diff-add";
    else if (line.startsWith("-")) span.className = "diff-del";
    span.textContent = line + "\n";
    gitDiff.appendChild(span);
  }
}

async function selectGitFile(change) {
  gitSelected = change.path;
  renderGitList();
  const untracked = change.index === "?" && change.worktree === "?";
  if (untracked) {
    gitDiff.textContent = `${change.path} is untracked — no diff available until it is staged.`;
    return;
  }
  const staged = change.worktree === " " && change.index !== "?";
  try {
    const diff = await invoke("git_diff", { path: change.path, staged });
    if (diff) renderGitDiff(diff);
    else gitDiff.textContent = "No diff for this file.";
  } catch (error) {
    gitDiff.textContent = `git diff failed: ${String(error)}`;
  }
}

document.getElementById("git-btn").addEventListener("click", async () => {
  gitPanel.classList.remove("hidden");
  await refreshGit();
});

document.getElementById("git-refresh").addEventListener("click", refreshGit);

document.getElementById("git-close").addEventListener("click", () => {
  gitPanel.classList.add("hidden");
});

// --- Terminal --------------------------------------------------------------

const terminalPanel = document.getElementById("terminal");
const terminalOutput = document.getElementById("terminal-output");
const terminalInput = document.getElementById("terminal-input");
const terminalStatus = document.getElementById("terminal-status");
let terminalRunning = false;

listen("terminal-output", (event) => {
  terminalOutput.textContent += event.payload;
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
});

async function startTerminal() {
  try {
    await invoke("terminal_start");
    terminalRunning = true;
    terminalStatus.textContent = "running";
  } catch (error) {
    terminalOutput.textContent += `failed to start terminal: ${String(error)}\n`;
  }
}

async function stopTerminal() {
  try {
    await invoke("terminal_stop");
  } catch (error) {
    console.error(error);
  }
  terminalRunning = false;
  terminalStatus.textContent = "stopped";
}

document.getElementById("terminal-btn").addEventListener("click", async () => {
  terminalPanel.classList.remove("hidden");
  terminalInput.focus();
  if (!terminalRunning) {
    await startTerminal();
  }
});

document
  .getElementById("terminal-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const command = terminalInput.value;
    terminalInput.value = "";
    if (!command.trim() || !terminalRunning) return;
    terminalOutput.textContent += `> ${command}\n`;
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
    try {
      await invoke("terminal_write", { command });
    } catch (error) {
      terminalOutput.textContent += `failed to write: ${String(error)}\n`;
    }
  });

document.getElementById("terminal-stop").addEventListener("click", stopTerminal);

document.getElementById("terminal-close").addEventListener("click", () => {
  terminalPanel.classList.add("hidden");
});

// --- Automations (cron) ----------------------------------------------------

const cronPanel = document.getElementById("cron");
const cronList = document.getElementById("cron-list");
const cronSummary = document.getElementById("cron-summary");

async function refreshCron() {
  try {
    const tasks = await invoke("list_cron_tasks");
    cronSummary.textContent = `${tasks.length} task(s)`;
    cronList.innerHTML = "";
    for (const task of tasks) {
      const item = document.createElement("li");
      item.className = "memo-item";
      const head = document.createElement("div");
      head.className = "memo-head";
      const badge = document.createElement("span");
      badge.className = "memo-kind";
      badge.textContent = task.recurring ? "recurring" : "one-shot";
      const expr = document.createElement("code");
      expr.textContent = task.cron;
      const stamp = document.createElement("span");
      stamp.className = "memo-time";
      stamp.textContent = task.lastFiredAt
        ? `last fired ${new Date(task.lastFiredAt).toLocaleString()}`
        : "not fired yet";
      const remove = document.createElement("button");
      remove.className = "memo-delete";
      remove.textContent = "✕";
      remove.addEventListener("click", async () => {
        try {
          await invoke("delete_cron_task", { id: task.id });
          await refreshCron();
        } catch (error) {
          console.error(error);
        }
      });
      head.append(badge, expr, stamp, remove);
      const prompt = document.createElement("div");
      prompt.className = "memo-need";
      prompt.textContent = task.prompt;
      item.append(head, prompt);
      cronList.appendChild(item);
    }
    if (cronList.children.length === 0) {
      const empty = document.createElement("li");
      empty.className = "memo-empty";
      empty.textContent = "no scheduled tasks";
      cronList.appendChild(empty);
    }
  } catch (error) {
    console.error("list_cron_tasks failed:", error);
  }
}

document.getElementById("cron-btn").addEventListener("click", async () => {
  cronPanel.classList.remove("hidden");
  await refreshCron();
});

document.getElementById("cron-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const cron = document.getElementById("cron-expr").value.trim();
  const prompt = document.getElementById("cron-prompt").value.trim();
  const recurring = document.getElementById("cron-recurring").checked;
  if (!cron || !prompt) return;
  try {
    await invoke("create_cron_task", { cron, prompt, recurring });
    document.getElementById("cron-expr").value = "";
    document.getElementById("cron-prompt").value = "";
    await refreshCron();
  } catch (error) {
    alert(`failed to create task: ${String(error)}`);
  }
});

document.getElementById("cron-close").addEventListener("click", () => {
  cronPanel.classList.add("hidden");
});

// --- Worktrees -------------------------------------------------------------

const worktreePanel = document.getElementById("worktrees");
const worktreeList = document.getElementById("worktree-list");
const worktreeSummary = document.getElementById("worktree-summary");

async function refreshWorktrees() {
  try {
    const worktrees = await invoke("worktree_list");
    worktreeSummary.textContent = `${worktrees.length} worktree(s)`;
    worktreeList.innerHTML = "";
    for (const worktree of worktrees) {
      const item = document.createElement("li");
      item.className = "memo-item";
      const head = document.createElement("div");
      head.className = "memo-head";
      const badge = document.createElement("span");
      badge.className = "memo-kind";
      badge.textContent = worktree.branch ?? "detached";
      const hash = document.createElement("code");
      hash.textContent = worktree.head;
      const remove = document.createElement("button");
      remove.className = "memo-delete";
      remove.textContent = "✕";
      remove.title = "Remove worktree";
      remove.addEventListener("click", async () => {
        try {
          await invoke("worktree_remove", { path: worktree.path });
          await refreshWorktrees();
        } catch (error) {
          alert(`failed to remove worktree: ${String(error)}`);
        }
      });
      head.append(badge, hash);
      head.appendChild(remove);
      const path = document.createElement("div");
      path.className = "memo-need";
      path.textContent = worktree.path;
      item.append(head, path);
      worktreeList.appendChild(item);
    }
    if (worktreeList.children.length === 0) {
      const empty = document.createElement("li");
      empty.className = "memo-empty";
      empty.textContent = "no worktrees";
      worktreeList.appendChild(empty);
    }
  } catch (error) {
    console.error("worktree_list failed:", error);
  }
}

document.getElementById("worktree-btn").addEventListener("click", async () => {
  worktreePanel.classList.remove("hidden");
  await refreshWorktrees();
});

document
  .getElementById("worktree-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const path = document.getElementById("worktree-path").value.trim();
    const branch = document.getElementById("worktree-branch").value.trim();
    if (!path) return;
    try {
      await invoke("worktree_add", { path, branch: branch || null });
      document.getElementById("worktree-path").value = "";
      document.getElementById("worktree-branch").value = "";
      await refreshWorktrees();
    } catch (error) {
      alert(`failed to add worktree: ${String(error)}`);
    }
  });

document.getElementById("worktree-close").addEventListener("click", () => {
  worktreePanel.classList.add("hidden");
});

// --- Subagents -------------------------------------------------------------

const subagentPanel = document.getElementById("subagents");
const subagentList = document.getElementById("subagent-list");
const subagentSummary = document.getElementById("subagent-summary");

async function refreshSubagents() {
  try {
    const runs = await invoke("list_subagents");
    const running = runs.filter((run) => run.status === "running").length;
    subagentSummary.textContent = `${runs.length} run(s)${running ? ` · ${running} running` : ""}`;
    subagentList.innerHTML = "";
    for (const run of runs) {
      const item = document.createElement("li");
      item.className = "memo-item";
      const head = document.createElement("div");
      head.className = "memo-head";
      const badge = document.createElement("span");
      badge.className = `memo-kind memo-kind-${run.status}`;
      badge.textContent = `${run.profile} · ${run.status}`;
      const stamp = document.createElement("span");
      stamp.className = "memo-time";
      stamp.textContent = run.finishedAt
        ? `${new Date(run.startedAt * 1000).toLocaleTimeString()} → ${new Date(run.finishedAt * 1000).toLocaleTimeString()}`
        : `started ${new Date(run.startedAt * 1000).toLocaleTimeString()}`;
      head.append(badge, stamp);
      const prompt = document.createElement("div");
      prompt.className = "memo-need";
      prompt.textContent = run.promptSummary;
      item.append(head, prompt);
      subagentList.appendChild(item);
    }
    if (subagentList.children.length === 0) {
      const empty = document.createElement("li");
      empty.className = "memo-empty";
      empty.textContent = "no subagent runs yet";
      subagentList.appendChild(empty);
    }
  } catch (error) {
    console.error("list_subagents failed:", error);
  }
}

document.getElementById("subagent-btn").addEventListener("click", async () => {
  subagentPanel.classList.remove("hidden");
  await refreshSubagents();
});

document
  .getElementById("subagent-refresh")
  .addEventListener("click", refreshSubagents);

document.getElementById("subagent-close").addEventListener("click", () => {
  subagentPanel.classList.add("hidden");
});

// --- Inbox -----------------------------------------------------------------

const inboxPanel = document.getElementById("inbox");
const inboxList = document.getElementById("inbox-list");
const inboxSummary = document.getElementById("inbox-summary");

async function refreshInbox() {
  try {
    const items = await invoke("list_inbox");
    const unread = items.filter((item) => !item.read).length;
    inboxSummary.textContent = `${items.length} item(s)${unread ? ` · ${unread} unread` : ""}`;
    inboxList.innerHTML = "";
    for (const item of items) {
      const entry = document.createElement("li");
      entry.className = "memo-item" + (item.read ? "" : " inbox-unread");
      const head = document.createElement("div");
      head.className = "memo-head";
      const badge = document.createElement("span");
      badge.className = `memo-kind memo-kind-${item.outcome}`;
      badge.textContent = item.kind;
      const stamp = document.createElement("span");
      stamp.className = "memo-time";
      stamp.textContent = new Date(item.createdAt * 1000).toLocaleTimeString();
      head.append(badge, stamp);
      const message = document.createElement("div");
      message.className = "memo-need";
      message.textContent = item.message;
      entry.append(head, message);
      inboxList.appendChild(entry);
    }
    if (inboxList.children.length === 0) {
      const empty = document.createElement("li");
      empty.className = "memo-empty";
      empty.textContent = "inbox is empty";
      inboxList.appendChild(empty);
    }
  } catch (error) {
    console.error("list_inbox failed:", error);
  }
}

document.getElementById("inbox-btn").addEventListener("click", async () => {
  inboxPanel.classList.remove("hidden");
  await refreshInbox();
});

document
  .getElementById("inbox-mark-read")
  .addEventListener("click", async () => {
    try {
      await invoke("mark_inbox_read");
      await refreshInbox();
    } catch (error) {
      console.error(error);
    }
  });

document.getElementById("inbox-clear").addEventListener("click", async () => {
  try {
    await invoke("clear_inbox");
    await refreshInbox();
  } catch (error) {
    console.error(error);
  }
});

document.getElementById("inbox-close").addEventListener("click", () => {
  inboxPanel.classList.add("hidden");
});

// --- Artifacts -------------------------------------------------------------

const artifactPanel = document.getElementById("artifacts");
const artifactList = document.getElementById("artifact-list");
const artifactContent = document.getElementById("artifact-content");
const artifactSummary = document.getElementById("artifact-summary");

async function refreshArtifacts() {
  try {
    const artifacts = await invoke("list_artifacts");
    artifactSummary.textContent = `${artifacts.length} artifact(s)`;
    artifactList.innerHTML = "";
    for (const artifact of artifacts) {
      const item = document.createElement("li");
      item.className = "git-item";
      const name = document.createElement("span");
      name.className = "git-path";
      name.textContent = artifact.name;
      const stamp = document.createElement("span");
      stamp.className = "memo-time";
      stamp.textContent = new Date(artifact.modifiedAt * 1000).toLocaleDateString();
      item.append(name, stamp);
      item.addEventListener("click", () => openArtifact(artifact));
      artifactList.appendChild(item);
    }
    if (artifactList.children.length === 0) {
      const empty = document.createElement("li");
      empty.className = "memo-empty";
      empty.textContent = "no artifacts yet (plans appear here)";
      artifactList.appendChild(empty);
    }
  } catch (error) {
    console.error("list_artifacts failed:", error);
  }
}

async function openArtifact(artifact) {
  try {
    const content = await invoke("read_artifact", { id: artifact.id });
    renderArtifactMarkdown(content);
  } catch (error) {
    artifactContent.textContent = `failed to read artifact: ${String(error)}`;
  }
}

/// Minimal markdown pass (headings / code fences / list items).
function renderArtifactMarkdown(text) {
  artifactContent.innerHTML = "";
  let inCode = false;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    const line = document.createElement("div");
    if (inCode) {
      line.className = "art-code";
      line.textContent = raw || " ";
    } else if (/^#{1,6} /.test(trimmed)) {
      line.className = "art-heading";
      line.textContent = trimmed.replace(/^#+ /, "");
    } else if (/^[-*] /.test(trimmed)) {
      line.className = "art-item";
      line.textContent = "• " + trimmed.slice(2);
    } else {
      line.textContent = raw || " ";
    }
    artifactContent.appendChild(line);
  }
}

document.getElementById("artifact-btn").addEventListener("click", async () => {
  artifactPanel.classList.remove("hidden");
  await refreshArtifacts();
});

document
  .getElementById("artifact-refresh")
  .addEventListener("click", refreshArtifacts);

document.getElementById("artifact-close").addEventListener("click", () => {
  artifactPanel.classList.add("hidden");
});

// --- Remote access ---------------------------------------------------------

const remotePanel = document.getElementById("remote");
const remoteList = document.getElementById("remote-list");
const remoteSummary = document.getElementById("remote-summary");

function renderRemote(state) {
  remoteList.innerHTML = "";
  if (!state) {
    remoteSummary.textContent = "stopped";
    const empty = document.createElement("li");
    empty.className = "memo-empty";
    empty.textContent = "remote access is stopped";
    remoteList.appendChild(empty);
    return;
  }
  remoteSummary.textContent = `running on port ${state.port}`;
  const tokenItem = document.createElement("li");
  tokenItem.className = "memo-item";
  tokenItem.innerHTML =
    '<div class="memo-head"><span class="memo-kind">token</span></div>' +
    `<div class="memo-need"><code>${state.token}</code></div>`;
  remoteList.appendChild(tokenItem);
  for (const url of state.lanUrls) {
    const item = document.createElement("li");
    item.className = "memo-item";
    item.innerHTML =
      '<div class="memo-head"><span class="memo-kind memo-kind-success">url</span></div>' +
      `<div class="memo-need">${url}/#token=${state.token}</div>`;
    remoteList.appendChild(item);
  }
}

async function refreshRemote() {
  try {
    const state = await invoke("remote_status");
    renderRemote(state);
  } catch (error) {
    console.error("remote_status failed:", error);
  }
}

document.getElementById("remote-btn").addEventListener("click", async () => {
  remotePanel.classList.remove("hidden");
  await refreshRemote();
});

document.getElementById("remote-start").addEventListener("click", async () => {
  try {
    const state = await invoke("remote_start");
    renderRemote(state);
  } catch (error) {
    alert(`failed to start remote access: ${String(error)}`);
  }
});

document.getElementById("remote-stop").addEventListener("click", async () => {
  try {
    await invoke("remote_stop");
    await refreshRemote();
  } catch (error) {
    console.error(error);
  }
});

document.getElementById("remote-close").addEventListener("click", () => {
  remotePanel.classList.add("hidden");
});

listen("agent-event", (event) => {
  const payload = event.payload;
  switch (payload.type) {
    case "sessionReady":
      modelLabel = `${payload.model} · ${payload.session.slice(-8)}`;
      currentSession = payload.session;
      setStatus("ok", modelLabel);
      void refreshSessions();
      break;
    case "textDelta":
      appendText(ensureAssistant(), payload.text);
      break;
    case "thinkDelta":
      appendText(ensureThink(), payload.text);
      break;
    case "toolStart":
      addTool(payload.name, payload.arguments);
      break;
    case "toolEnd":
      markTool(payload.name, payload.ok, payload.result);
      break;
    case "notice":
      addBlock("msg notice", payload.message);
      break;
    case "error":
      addBlock("msg error", "error: " + payload.message);
      break;
    case "approvalRequest":
      showApproval(payload.name, payload.arguments);
      break;
    case "turnFinished":
      currentAssistant = null;
      currentThink = null;
      setStatus("ok", modelLabel || "ready");
      break;
    default:
      break;
  }
});

// --- Attachments -----------------------------------------------------------
let pendingImages = [];

function renderAttachPreview() {
  const wrap = document.getElementById("attach-preview");
  wrap.innerHTML = "";
  wrap.classList.toggle("hidden", pendingImages.length === 0);
  pendingImages.forEach((path, index) => {
    const item = document.createElement("div");
    item.className = "attach-thumb-wrap";
    const img = document.createElement("img");
    img.className = "attach-thumb";
    img.src = window.__TAURI__.core.convertFileSrc(path);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attach-remove";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      pendingImages.splice(index, 1);
      renderAttachPreview();
    });
    item.appendChild(img);
    item.appendChild(remove);
    wrap.appendChild(item);
  });
}

document.getElementById("attach-btn").addEventListener("click", async () => {
  try {
    const selected = await window.__TAURI__.dialog.open({
      multiple: true,
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
      ],
    });
    if (!selected) return;
    const list = Array.isArray(selected) ? selected : [selected];
    pendingImages.push(...list);
    renderAttachPreview();
  } catch (error) {
    addBlock("msg error", "attach failed: " + error);
  }
});

// --- Session search --------------------------------------------------------
document.getElementById("session-search").addEventListener("input", (event) => {
  const needle = event.target.value.trim().toLowerCase();
  for (const item of sessionList.children) {
    const title = item.querySelector(".session-title")?.textContent || "";
    const meta = item.querySelector(".session-meta")?.textContent || "";
    item.style.display = `${title} ${meta}`.toLowerCase().includes(needle)
      ? ""
      : "none";
  }
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text && pendingImages.length === 0) return;
  const images = pendingImages.slice();
  input.value = "";
  pendingImages = [];
  renderAttachPreview();
  document.getElementById("welcome")?.remove();
  addUser(text, images);
  if (!document.getElementById("status-title").textContent && text) {
    updateStatusTitle(text.slice(0, 60));
  }
  setStatus("busy", "thinking…");
  try {
    await invoke("send_message", { message: text, images });
  } catch (error) {
    addBlock("msg error", "failed to send: " + error);
  }
});

document.getElementById("approve-btn").addEventListener("click", async () => {
  hideApproval();
  await invoke("approve_tool", { approved: true });
});

document.getElementById("deny-btn").addEventListener("click", async () => {
  hideApproval();
  await invoke("approve_tool", { approved: false });
});

window.addEventListener("keydown", async (event) => {
  if (event.key === "Escape") {
    try {
      await invoke("cancel_turn");
    } catch {
      // ignore
    }
  }
});

// The SessionReady event can fire before this script subscribes; poll the
// status command until the agent reports itself up.
let statusAttempts = 0;
const statusPoll = setInterval(async () => {
  statusAttempts += 1;
  try {
    const status = await invoke("get_status");
    if (status) {
      modelLabel = `${status.model} · ${status.session.slice(-8)}`;
      currentSession = status.session;
      setStatus("ok", modelLabel);
      clearInterval(statusPoll);
      void refreshSessions();
      return;
    }
  } catch { /* status is not up yet */ }
  if (statusAttempts > 20) clearInterval(statusPoll);
}, 500);

input.focus();
