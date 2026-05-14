import { config } from "./config.js";
import { ObjectiveError } from "./errors.js";
import { shapeTicketPayload, ticketSummary } from "./responses.js";
import {
  attachArtifact,
  claimFiles,
  claimTicket,
  createAgent,
  createProject,
  createTicket,
  getArtifactUrl,
  getAvailableTickets,
  getFileClaims,
  getProject,
  heartbeat,
  listAgentWork,
  listProofArtifacts,
  recordTest,
  releaseTicket,
  renewTicketLease,
  submitDone,
} from "./lifecycle.js";
import { toolManifest } from "./manifest.js";
import { responseMode } from "./validation.js";

export function leaseHints(ticket, leaseToken = ticket?.leaseToken) {
  if (!ticket) return null;
  const expiresAt = ticket.leaseExpiresAt ? new Date(ticket.leaseExpiresAt) : null;
  return {
    leaseToken,
    leaseExpiresAt: ticket.leaseExpiresAt,
    leaseTtlSeconds: config.leaseTtlSeconds,
    renewAt: expiresAt
      ? new Date(expiresAt.getTime() - Math.max(30, Math.floor(config.leaseTtlSeconds / 3)) * 1000).toISOString()
      : null,
  };
}

function compactManifest(tools, pluginKind) {
  const { tools: _omittedTools, ...manifest } = toolManifest({ tools: [], pluginKind });
  return {
    ...manifest,
    toolCount: tools.length,
    toolsOmitted: true,
    toolManifestTool: "objective_tool_manifest",
  };
}

function fileClaimSummary(claim) {
  if (!claim) return null;
  return {
    id: claim.id,
    ticketId: claim.ticket_id,
    ticketTitle: claim.ticket_title,
    projectName: claim.project_name,
    agentId: claim.agent_id,
    pathPattern: claim.path_pattern,
    expiresAt: claim.expires_at,
  };
}

export async function claimTicketAndFiles({
  ticketId,
  agentId,
  files,
  idempotencyKey,
  keepTicketClaimOnFileConflict = false,
  responseMode: mode = "summary",
}) {
  const selectedMode = responseMode(mode);
  const claimed = await claimTicket({ ticketId, agentId, idempotencyKey: idempotencyKey ? `${idempotencyKey}:ticket` : undefined });
  try {
    const fileClaims = await claimFiles({
      ticketId,
      agentId,
      leaseToken: claimed.leaseToken,
      files,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:files` : undefined,
    });
    return {
      ok: true,
      ticket: selectedMode === "summary" ? ticketSummary(claimed.ticket) : claimed.ticket,
      lease: leaseHints(claimed.ticket, claimed.leaseToken),
      claims: fileClaims.claims,
    };
  } catch (err) {
    if (!keepTicketClaimOnFileConflict) {
      await releaseTicket({ ticketId, agentId, leaseToken: claimed.leaseToken }).catch(() => null);
      err.details = { ...(err.details ?? {}), ticketClaimRolledBack: true };
    }
    throw err;
  }
}

export async function recordTestAndAttachLog({
  ticketId,
  agentId,
  leaseToken,
  command,
  status,
  output = "",
  filename = "objective-test-log.txt",
  idempotencyKey,
  responseMode: mode = "summary",
}) {
  const test = await recordTest({
    ticketId,
    agentId,
    leaseToken,
    command,
    status,
    output,
    idempotencyKey: idempotencyKey ? `${idempotencyKey}:test` : undefined,
  });
  try {
    const artifact = await attachArtifact({
      ticketId,
      agentId,
      leaseToken,
      type: "test-log",
      filename,
      mimeType: "text/plain",
      content: output || `${status}: ${command}`,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:artifact` : undefined,
    });
    return {
      ok: true,
      testRun: test.testRun,
      ticket: shapeTicketPayload({ ticket: test.ticket }, mode).ticket,
      artifact,
    };
  } catch (err) {
    return {
      ok: false,
      partial: true,
      testRun: test.testRun,
      ticket: shapeTicketPayload({ ticket: test.ticket }, mode).ticket,
      error: err.code ?? "artifact_attach_failed",
      message: err.message,
    };
  }
}

export async function latestArtifactProofUrl(ticketId) {
  const artifacts = await listProofArtifacts(ticketId);
  if (!artifacts.length) return "";
  const latest = artifacts[0];
  if (latest.downloadUrl) return latest.downloadUrl;
  if (!latest.object_key) return "";
  return getArtifactUrl(latest.object_key);
}

export async function submitDoneWithArtifacts({
  ticketId,
  agentId,
  leaseToken,
  finalAgentSummary,
  proofUrl,
  actualFilesChanged,
  proof,
  responseMode: mode = "summary",
}) {
  let attached = null;
  if (proof?.filename) {
    attached = await attachArtifact({
      ticketId,
      agentId,
      leaseToken,
      type: proof.type ?? "text-proof",
      filename: proof.filename,
      mimeType: proof.mimeType ?? "text/plain",
      content: proof.content ?? "",
      idempotencyKey: proof.idempotencyKey,
    });
  }
  const resolvedProofUrl = proofUrl || attached?.downloadUrl || attached?.presignedUrl || (await latestArtifactProofUrl(ticketId));
  const result = await submitDone({
    ticketId,
    agentId,
    leaseToken,
    finalAgentSummary,
    proofUrl: resolvedProofUrl,
    actualFilesChanged,
  });
  return {
    ...result,
    ticket: shapeTicketPayload({ ticket: result.ticket }, mode).ticket,
    artifact: attached?.artifact,
    proofUrl: resolvedProofUrl,
  };
}

export async function keepalive({ agentId, ticketId = null, leaseToken = null, sessionId = null, metadata = {} }) {
  const beat = await heartbeat({ agentId, ticketId, sessionId, metadata });
  let lease = null;
  if (ticketId && leaseToken) {
    const renewed = await renewTicketLease({ ticketId, agentId, leaseToken });
    lease = leaseHints(renewed.ticket, leaseToken);
  }
  return { heartbeat: beat, lease };
}

export async function agentBootstrap({
  agentName,
  name,
  kind = "unknown",
  agentId = null,
  externalKey = null,
  projectId = null,
  projectQuery = "",
  limit = config.defaultPageSize,
  tools = [],
  pluginKind = kind === "claude" ? "claude" : "codex",
}) {
  const agent = agentId
    ? { id: agentId, name: agentName ?? name ?? "Objective Agent", kind }
    : await createAgent({
        name: agentName ?? name ?? "Objective Agent",
        kind,
        externalKey: externalKey ?? `${kind}:${agentName ?? name ?? "objective-agent"}`,
      });
  const work = agent.id ? await listAgentWork(agent.id, { limit }) : { items: [] };
  const projects = await import("./lifecycle.js").then((mod) =>
    mod.listProjects({ q: projectQuery, limit, includeArchived: false }),
  );
  const selectedProjectId = projectId ?? projects.items?.[0]?.id ?? projects[0]?.id ?? null;
  const project = selectedProjectId ? await getProject(selectedProjectId) : null;
  const availableTickets = selectedProjectId ? await getAvailableTickets(selectedProjectId, { limit }) : { items: [] };
  const activeLeases = agent.id ? await getFileClaims({ activeOnly: true, limit }) : { items: [] };
  return {
    agent,
    project,
    availableTickets: (availableTickets.items ?? availableTickets).map(ticketSummary),
    activeWork: (work.items ?? work).map(ticketSummary),
    activeLeases: (activeLeases.items ?? activeLeases).map(fileClaimSummary),
    manifest: compactManifest(tools, pluginKind),
  };
}

export function completionError(checklist) {
  return new ObjectiveError(
    "completion_gate_failed",
    "Ticket cannot be marked Done until all required evidence exists.",
    409,
    checklist,
  );
}
