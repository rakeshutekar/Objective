import { responseMode } from "./validation.js";

export function projectSummary(project) {
  if (!project) return null;
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    archivedAt: project.archivedAt,
    isTest: project.isTest,
  };
}

export function ticketSummary(ticket) {
  if (!ticket) return null;
  return {
    id: ticket.id,
    projectId: ticket.projectId,
    title: ticket.title,
    status: ticket.status,
    assignedAgentId: ticket.assignedAgentId,
    leaseToken: ticket.leaseToken,
    leaseExpiresAt: ticket.leaseExpiresAt,
    actualFilesChanged: ticket.actualFilesChanged ?? [],
    proofUrl: ticket.proofUrl,
    archivedAt: ticket.archivedAt,
    isTest: ticket.isTest,
  };
}

export function artifactSummary(artifact) {
  if (!artifact) return null;
  return {
    id: artifact.id,
    type: artifact.type,
    filename: artifact.filename,
    mimeType: artifact.mime_type ?? artifact.mimeType,
    sizeBytes: artifact.size_bytes ?? artifact.sizeBytes,
    checksum: artifact.checksum,
    downloadUrl: artifact.downloadUrl,
    presignedUrl: artifact.presignedUrl,
  };
}

export function leaseSummary({ ticket, leaseToken, leaseTtlSeconds, renewAt } = {}) {
  if (!ticket) return null;
  return {
    ticketId: ticket.id,
    status: ticket.status,
    leaseToken,
    leaseExpiresAt: ticket.leaseExpiresAt,
    leaseTtlSeconds,
    renewAt,
  };
}

export function shapeTicketPayload(payload, mode = "full") {
  const selected = responseMode(mode);
  if (selected === "full") return payload;
  return {
    ...payload,
    ticket: ticketSummary(payload.ticket),
  };
}

export function shapeProjectPage(page, mode = "summary") {
  const selected = responseMode(mode);
  const projects = selected === "full" ? page.items : page.items.map(projectSummary);
  return {
    projects,
    count: page.count,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    total: page.total,
  };
}

export function shapeTicketPage(page, mode = "summary") {
  const selected = responseMode(mode);
  const tickets = selected === "full" ? page.items : page.items.map(ticketSummary);
  return {
    tickets,
    count: page.count,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    total: page.total,
  };
}
