const apiKey = "dev-agent-key";
const statuses = ["Ready", "Claimed", "In Progress", "Blocked", "Proof Submitted", "Done"];

const state = {
  projects: [],
  selectedProjectId: null,
  tickets: [],
  claims: [],
  selectedTicketId: null,
  includeArchived: false,
  manifest: null,
};

const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json", authorization: `Bearer ${apiKey}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || "Objective API error");
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function list(items) {
  if (!items?.length) return '<span class="muted">None</span>';
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function setView(view) {
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  document.querySelectorAll(".view").forEach((item) => item.classList.toggle("active", item.id === `${view}-view`));
  $("#page-title").textContent = view[0].toUpperCase() + view.slice(1);
}

async function load() {
  const health = await api("/api/health").catch(() => ({ ok: false }));
  const healthPill = $("#health-pill");
  healthPill.textContent = health.ok ? "Local services online" : "Service issue";
  healthPill.className = `health ${health.ok ? "ok" : "error"}`;

  const projects = await api(`/api/projects?includeArchived=${state.includeArchived}`);
  state.projects = projects.projects;
  if (state.selectedProjectId && !state.projects.some((project) => project.id === state.selectedProjectId)) {
    state.selectedProjectId = null;
  }
  if (!state.selectedProjectId && state.projects[0]) state.selectedProjectId = state.projects[0].id;

  if (state.selectedProjectId) {
    const tickets = await api(`/api/projects/${state.selectedProjectId}/tickets?includeArchived=${state.includeArchived}`);
    const claims = await api(`/api/file-claims?projectId=${state.selectedProjectId}&includeArchived=${state.includeArchived}`);
    state.tickets = tickets.tickets;
    state.claims = claims.claims;
  } else {
    state.tickets = [];
    state.claims = [];
  }

  state.manifest = await api("/api/tool-manifest").catch(() => null);

  render();
}

function render() {
  renderProjects();
  renderMetrics();
  renderDashboard();
  renderBoard();
  renderLocks();
  renderRuntime();
  if (state.selectedTicketId) renderDetail(state.selectedTicketId);
}

function renderProjects() {
  $("#project-list").innerHTML = state.projects
    .map(
      (project) => `
        <button class="project-button ${project.id === state.selectedProjectId ? "active" : ""}" data-project-id="${project.id}">
          <strong>${escapeHtml(project.name)}</strong>
          <span class="muted">${escapeHtml(project.description || "No description")}</span>
          <span class="ticket-meta">
            ${project.isTest ? '<span class="badge">test</span>' : ""}
            ${project.archivedAt ? '<span class="badge blocked">archived</span>' : ""}
          </span>
        </button>
      `,
    )
    .join("");
  $("#board-project-title").textContent =
    state.projects.find((project) => project.id === state.selectedProjectId)?.name ?? "Project Board";
}

function renderMetrics() {
  const counts = Object.fromEntries(statuses.map((status) => [status, state.tickets.filter((ticket) => ticket.status === status).length]));
  $("#metric-grid").innerHTML = [
    ["Active", counts.Claimed + counts["In Progress"]],
    ["Blocked", counts.Blocked],
    ["Proof", counts["Proof Submitted"]],
    ["Done", counts.Done],
    ["Leases", state.claims.length],
    ["Test", state.tickets.filter((ticket) => ticket.isTest).length],
  ]
    .map(([label, value]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`)
    .join("");
}

function ticketRow(ticket) {
  return `
    <button class="ticket-row" data-ticket-id="${ticket.id}">
      <strong>${escapeHtml(ticket.title)}</strong>
      <span class="muted">${escapeHtml(ticket.why)}</span>
      <div class="ticket-meta">
        <span class="badge">${escapeHtml(ticket.status)}</span>
        <span class="badge">${ticket.actualFilesChanged?.length || 0} files</span>
      </div>
    </button>
  `;
}

function renderDashboard() {
  const active = state.tickets.filter((ticket) => ["Claimed", "In Progress", "Blocked"].includes(ticket.status));
  const proof = state.tickets.filter((ticket) => ["Proof Submitted", "Verification Failed", "Done"].includes(ticket.status));
  $("#active-work").innerHTML = active.length ? active.map(ticketRow).join("") : '<p class="muted">No active work.</p>';
  $("#proof-review").innerHTML = proof.length ? proof.map(ticketRow).join("") : '<p class="muted">No proof submitted yet.</p>';
}

function renderBoard() {
  $("#ticket-board").innerHTML = statuses
    .map((status) => {
      const tickets = state.tickets.filter((ticket) => ticket.status === status);
      return `
        <section class="column">
          <h3>${escapeHtml(status)} · ${tickets.length}</h3>
          ${tickets
            .map(
              (ticket) => `
                <article class="ticket-card" data-ticket-id="${ticket.id}">
                  <strong>${escapeHtml(ticket.title)}</strong>
                  <p class="muted">${escapeHtml(ticket.description)}</p>
                  <div class="ticket-meta">
                    <span class="badge">${ticket.plannedFiles?.length || 0} planned</span>
                    <span class="badge">${ticket.testsPerformed?.length || 0} tests</span>
                    ${ticket.isTest ? '<span class="badge">test</span>' : ""}
                    ${ticket.archivedAt ? '<span class="badge blocked">archived</span>' : ""}
                  </div>
                </article>
              `,
            )
            .join("")}
        </section>
      `;
    })
    .join("");
}

function renderLocks() {
  $("#locks-list").innerHTML = state.claims.length
    ? state.claims
        .map(
          (claim) => `
            <div class="lock-row">
              <strong>${escapeHtml(claim.normalized_pattern)}</strong>
              <span class="muted">${escapeHtml(claim.ticket_title)} · expires ${new Date(claim.expires_at).toLocaleTimeString()}</span>
            </div>
          `,
        )
        .join("")
    : '<p class="muted">No active file locks.</p>';
}

async function renderDetail(ticketId) {
  state.selectedTicketId = ticketId;
  const [{ ticket, artifacts }, completion, events] = await Promise.all([
    api(`/api/tickets/${ticketId}`),
    api(`/api/tickets/${ticketId}/completion`),
    api(`/api/tickets/${ticketId}/events`),
  ]);
  const checks = Object.entries(completion.checklist)
    .map(([key, ok]) => `<div class="check ${ok ? "ok" : ""}"><span>${escapeHtml(key)}</span><strong>${ok ? "yes" : "no"}</strong></div>`)
    .join("");
  $("#detail-panel").innerHTML = `
    <h2>${escapeHtml(ticket.title)}</h2>
    <div class="ticket-meta">
      <span class="badge ${ticket.status === "Done" ? "done" : ""}">${escapeHtml(ticket.status)}</span>
      <span class="badge">lease ${ticket.leaseExpiresAt ? new Date(ticket.leaseExpiresAt).toLocaleTimeString() : "none"}</span>
      ${ticket.isTest ? '<span class="badge">test</span>' : ""}
      ${ticket.archivedAt ? '<span class="badge blocked">archived</span>' : ""}
    </div>
    <div class="detail-section">
      <h3>Why</h3>
      <p>${escapeHtml(ticket.why)}</p>
      <h3>Description</h3>
      <p>${escapeHtml(ticket.description)}</p>
    </div>
    <div class="detail-section">
      <h3>Completion Checklist</h3>
      <div class="checklist">${checks}</div>
    </div>
    <div class="detail-section">
      <h3>Files</h3>
      <p class="muted">Planned</p>${list(ticket.plannedFiles)}
      <p class="muted">Actual</p>${list(ticket.actualFilesChanged)}
    </div>
    <div class="detail-section">
      <h3>Tests</h3>
      ${list(ticket.testsPerformed)}
    </div>
    <div class="detail-section">
      <h3>Proof</h3>
      <p>${ticket.proofUrl ? `<a href="${escapeHtml(ticket.proofUrl)}" target="_blank">${escapeHtml(ticket.proofUrl)}</a>` : '<span class="muted">No proof URL</span>'}</p>
      ${
        artifacts.length
          ? artifacts.map((artifact) => `<p><strong>${escapeHtml(artifact.type)}</strong><br><a href="${escapeHtml(artifact.downloadUrl)}" target="_blank">${escapeHtml(artifact.filename)}</a><br><span class="muted">${artifact.size_bytes} bytes</span></p>`).join("")
          : '<p class="muted">No artifacts.</p>'
      }
    </div>
    <div class="detail-section">
      <h3>Final Agent Summary</h3>
      <p>${escapeHtml(ticket.finalAgentSummary || "No summary yet.")}</p>
    </div>
    <div class="detail-section">
      <h3>Events</h3>
      ${events.events.map((event) => `<div class="event"><strong>${escapeHtml(event.event_type)}</strong><br>${escapeHtml(event.message)}</div>`).join("")}
    </div>
  `;
}

function renderRuntime() {
  const manifest = state.manifest;
  if (!manifest) {
    $("#runtime-status").textContent = "Runtime metadata unavailable.";
    return;
  }
  $("#runtime-status").textContent = `API ${manifest.apiVersion} · schema ${manifest.schemaVersion} · lease ${manifest.defaults.leaseTtlSeconds}s`;
}

document.addEventListener("click", async (event) => {
  const nav = event.target.closest(".nav-item");
  if (nav) setView(nav.dataset.view);

  const project = event.target.closest("[data-project-id]");
  if (project) {
    state.selectedProjectId = project.dataset.projectId;
    state.selectedTicketId = null;
    await load();
  }

  const ticket = event.target.closest("[data-ticket-id]");
  if (ticket) {
    await renderDetail(ticket.dataset.ticketId);
  }
});

$("#refresh-button").addEventListener("click", load);

$("#include-archived-toggle").addEventListener("change", async (event) => {
  state.includeArchived = event.currentTarget.checked;
  await load();
});

$("#self-test-button").addEventListener("click", async () => {
  const target = $("#self-test-result");
  target.innerHTML = '<p class="muted">Running...</p>';
  try {
    const result = await api("/api/self-test", {
      method: "POST",
      body: JSON.stringify({ archive: true, retentionMinutes: 60 }),
    });
    target.innerHTML = `
      <div class="check ${result.ok ? "ok" : ""}">
        <span>Self-test</span><strong>${result.ok ? "passed" : "failed"}</strong>
      </div>
      ${result.steps
        .map((step) => `<div class="event"><strong>${escapeHtml(step.name)}</strong><br>${escapeHtml(step.status)} · ${step.latencyMs}ms</div>`)
        .join("")}
    `;
    await load();
  } catch (err) {
    target.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
  }
});

$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const created = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: form.get("name"), description: "" }),
  });
  state.selectedProjectId = created.project.id;
  event.currentTarget.reset();
  await load();
});

$("#ticket-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedProjectId) return;
  const form = new FormData(event.currentTarget);
  await api("/api/tickets", {
    method: "POST",
    body: JSON.stringify({
      projectId: state.selectedProjectId,
      title: form.get("title"),
      why: form.get("why"),
      description: form.get("description"),
      plannedFiles: String(form.get("plannedFiles") || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      testPlan: "Record tests before completion.",
      computerUseRequired: true,
    }),
  });
  event.currentTarget.reset();
  await load();
});

load().catch((err) => {
  $("#health-pill").textContent = err.message;
  $("#health-pill").className = "health error";
});

if ("EventSource" in window) {
  const events = new EventSource("/api/events");
  events.addEventListener("objective", () => {
    load().catch(() => {});
  });
}
