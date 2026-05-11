// Minimal vanilla JS client for dev-agent-server.
// Auth is handled transparently via the Cloudflare Access cookie.

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const sessionListEl = $("session-list");
const composeForm = $("compose");
const composeInput = $("compose-input");
const prBanner = $("pr-banner");
const modalBg = $("modal-bg");

const state = {
  currentSessionId: null,
  sessions: [],
  prPollTimer: null,
};

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  if (res.status === 204) return null;
  return await res.json();
}

async function loadProject() {
  try {
    const p = await api("GET", "/project");
    $("project-name").textContent = p.name || "dev-agent";
    $("project-desc").textContent = p.description || "";
    $("project-mode").textContent = p.shipEnabled ? `→ ${p.targetRepo}` : `${p.targetRepo} (chat-only)`;
  } catch (e) {
    console.error("loadProject", e);
  }
}

async function loadSessions() {
  state.sessions = await api("GET", "/sessions");
  renderSessionList();
}

function renderSessionList() {
  sessionListEl.innerHTML = "";
  if (state.sessions.length === 0) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "No sessions yet.";
    sessionListEl.appendChild(div);
    return;
  }
  for (const s of state.sessions) {
    const div = document.createElement("div");
    div.className = "session" + (s.id === state.currentSessionId ? " active" : "");
    div.innerHTML = `<div class="title"></div><div class="meta"></div>`;
    div.querySelector(".title").textContent = s.title;
    div.querySelector(".meta").textContent = new Date(s.last_message_at || s.created_at).toLocaleString();
    div.onclick = () => openSession(s.id);
    sessionListEl.appendChild(div);
  }
}

async function openSession(id) {
  state.currentSessionId = id;
  renderSessionList();
  closeDrawer();
  composeForm.style.display = "flex";
  messagesEl.innerHTML = "";
  const data = await api("GET", `/sessions/${id}`);
  for (const m of data.messages) renderStoredMessage(m);
  await refreshPrBanner();
  if (state.prPollTimer) clearInterval(state.prPollTimer);
  state.prPollTimer = setInterval(refreshPrBanner, 15000);
}

function renderStoredMessage(m) {
  if (m.role === "user") {
    appendMsg("user", m.content);
    return;
  }
  if (m.role === "assistant") {
    let blocks;
    try { blocks = JSON.parse(m.content); } catch { blocks = null; }
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b.type === "text") appendMsg("assistant", b.text);
        else if (b.type === "tool_use") appendToolCall(b.name, b.input);
      }
    } else {
      appendMsg("assistant", m.content);
    }
    return;
  }
  if (m.role === "tool_result") {
    let blocks;
    try { blocks = JSON.parse(m.content); } catch { blocks = null; }
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        appendToolResult(text);
      }
    }
  }
}

function appendMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="role"></div><div class="content"></div>`;
  div.querySelector(".role").textContent = role;
  div.querySelector(".content").textContent = text;
  messagesEl.appendChild(div);
  scrollDown();
  return div.querySelector(".content");
}

function appendToolCall(name, input) {
  const det = document.createElement("details");
  det.className = "tool";
  det.open = false;
  const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  det.innerHTML = `<summary>↳ ${name}</summary><pre></pre>`;
  det.querySelector("pre").textContent = inputStr;
  messagesEl.appendChild(det);
  scrollDown();
  return det;
}

function appendToolResult(text) {
  const det = document.createElement("details");
  det.className = "tool";
  det.open = false;
  det.innerHTML = `<summary>← result</summary><pre></pre>`;
  det.querySelector("pre").textContent = text;
  messagesEl.appendChild(det);
  scrollDown();
}

function scrollDown() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function refreshPrBanner() {
  if (!state.currentSessionId) return;
  try {
    const pr = await api("GET", `/sessions/${state.currentSessionId}/pr`);
    if (pr && pr.artifact_url) {
      prBanner.style.display = "flex";
      prBanner.innerHTML = `
        <div>
          <div><strong>📦 APK ready</strong> for PR #${pr.pr_number}</div>
          <div><a href="${pr.artifact_url}" target="_blank" rel="noreferrer" style="color:#9ece6a;">${pr.artifact_url}</a></div>
          ${pr.pr_url ? `<div style="font-size:12px;color:#8a93a6;"><a href="${pr.pr_url}" target="_blank" rel="noreferrer" style="color:#7aa2f7;">View PR →</a></div>` : ""}
        </div>
        ${pr.qr_url ? `<img src="${pr.qr_url}" alt="QR" />` : ""}
      `;
    } else if (pr && pr.pr_url) {
      prBanner.style.display = "flex";
      prBanner.innerHTML = `<div>PR #${pr.pr_number} opened. Waiting for build… <a href="${pr.pr_url}" target="_blank" rel="noreferrer" style="color:#7aa2f7;">View PR →</a></div>`;
    } else {
      prBanner.style.display = "none";
    }
  } catch {
    prBanner.style.display = "none";
  }
}

// ---- compose ----
composeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const content = composeInput.value.trim();
  if (!content || !state.currentSessionId) return;
  composeInput.value = "";
  appendMsg("user", content);
  await streamMessage(state.currentSessionId, content);
  await loadSessions();
  await refreshPrBanner();
});

async function streamMessage(sessionId, content) {
  // SSE doesn't support POST natively in EventSource. Use fetch + ReadableStream.
  const res = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ content }),
    credentials: "same-origin",
  });
  if (!res.ok || !res.body) {
    appendMsg("assistant", `[error: ${res.status}]`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let activeTextEl = null;

  const handleEvent = (eventName, dataStr) => {
    let data;
    try { data = JSON.parse(dataStr); } catch { data = { raw: dataStr }; }
    if (eventName === "token") {
      if (!activeTextEl) activeTextEl = appendMsg("assistant", "");
      activeTextEl.textContent += data.text || "";
      scrollDown();
    } else if (eventName === "tool_call") {
      activeTextEl = null;
      appendToolCall(data.name, data.input);
    } else if (eventName === "tool_result") {
      appendToolResult(typeof data.output === "string" ? data.output : JSON.stringify(data.output));
    } else if (eventName === "done") {
      activeTextEl = null;
    } else if (eventName === "error") {
      appendMsg("assistant", `[error: ${data.message}]`);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let eventName = "message";
      const dataLines = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) handleEvent(eventName, dataLines.join("\n"));
    }
  }
}

// ---- mobile drawer ----
function openDrawer() { document.body.classList.add("drawer-open"); }
function closeDrawer() { document.body.classList.remove("drawer-open"); }
function toggleDrawer(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  if (document.body.classList.contains("drawer-open")) closeDrawer();
  else openDrawer();
}
{
  const btn = $("menu-toggle");
  const scrim = $("scrim");
  if (btn) {
    // addEventListener (not .onclick) so nothing else overwrites it, and we
    // bind both click and touchend in case a mobile browser swallows one.
    btn.addEventListener("click", toggleDrawer);
    btn.addEventListener("touchend", toggleDrawer, { passive: false });
  } else {
    console.error("[ui] #menu-toggle not found at script load");
  }
  if (scrim) {
    scrim.addEventListener("click", closeDrawer);
    scrim.addEventListener("touchend", (e) => { e.preventDefault(); closeDrawer(); }, { passive: false });
  }
}

// ---- new session modal ----
$("new-session-btn").onclick = () => {
  modalBg.classList.add("show");
  $("new-title").value = "";
  $("new-report").value = "";
  $("new-report").focus();
};
$("new-cancel").onclick = () => modalBg.classList.remove("show");
$("new-submit").onclick = async () => {
  const title = $("new-title").value.trim();
  const report = $("new-report").value.trim();
  const created = await api("POST", "/sessions", {
    title: title || undefined,
    initial_report: report || undefined,
  });
  modalBg.classList.remove("show");
  await loadSessions();
  await openSession(created.id);
};

// ---- boot ----
loadProject();
loadSessions();
