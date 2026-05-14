import crypto from "node:crypto";
import { archiveProject } from "./archive.js";
import {
  createAgent,
  createProject,
  createTicket,
  validateTicketCompletion,
} from "./lifecycle.js";
import {
  claimTicketAndFiles,
  recordTestAndAttachLog,
  submitDoneWithArtifacts,
} from "./workflows.js";

async function step(name, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    return {
      name,
      status: "passed",
      latencyMs: Date.now() - startedAt,
      result,
    };
  } catch (err) {
    return {
      name,
      status: "failed",
      latencyMs: Date.now() - startedAt,
      error: err.code ?? "objective_self_test_step_failed",
      message: err.message,
      details: err.details,
    };
  }
}

export async function runSelfTest({ archive = true, retentionMinutes = 60 } = {}) {
  const run = crypto.randomUUID();
  const created = {};
  const steps = [];

  steps.push(
    await step("create_agent", async () => {
      const agent = await createAgent({
        name: `Objective Self Test ${run}`,
        kind: "system",
        externalKey: `objective-self-test:${run}`,
        metadata: { selfTest: true, run },
      });
      created.agentId = agent.id;
      return { agentId: agent.id };
    }),
  );
  if (steps.at(-1).status === "failed") return { ok: false, steps, created };

  steps.push(
    await step("create_project", async () => {
      const project = await createProject({
        name: `Objective Self Test ${run}`,
        description: "Disposable Objective self-test project.",
        isTest: true,
        retentionExpiresAt: new Date(Date.now() + retentionMinutes * 60 * 1000),
      });
      created.projectId = project.id;
      return { projectId: project.id };
    }),
  );
  if (steps.at(-1).status === "failed") return { ok: false, steps, created };

  steps.push(
    await step("create_ticket", async () => {
      const ticket = await createTicket({
        projectId: created.projectId,
        actorAgentId: created.agentId,
        title: "Objective self-test ticket",
        why: "Verify Objective end-to-end agent workflow.",
        description: "Disposable ticket created by objective_self_test.",
        plannedFiles: [`self-test/${run}.txt`],
        testPlan: "objective_self_test",
        computerUseRequired: false,
        isTest: true,
        retentionExpiresAt: new Date(Date.now() + retentionMinutes * 60 * 1000),
      });
      created.ticketId = ticket.ticket.id;
      return { ticketId: ticket.ticket.id };
    }),
  );
  if (steps.at(-1).status === "failed") return { ok: false, steps, created };

  let claim;
  steps.push(
    await step("claim_ticket_and_files", async () => {
      claim = await claimTicketAndFiles({
        ticketId: created.ticketId,
        agentId: created.agentId,
        files: [`self-test/${run}.txt`],
      });
      return {
        ticketId: claim.ticket.id,
        status: claim.ticket.status,
        leaseExpiresAt: claim.lease.leaseExpiresAt,
        claims: claim.claims.length,
      };
    }),
  );
  if (steps.at(-1).status === "failed") return { ok: false, steps, created };

  steps.push(
    await step("record_test_and_attach_log", async () => {
      const result = await recordTestAndAttachLog({
        ticketId: created.ticketId,
        agentId: created.agentId,
        leaseToken: claim.lease.leaseToken,
        command: "objective_self_test",
        status: "passed",
        output: `Objective self-test ${run} passed.`,
        filename: "objective-self-test.log",
      });
      return {
        ok: result.ok,
        testRunId: result.testRun?.id,
        artifactId: result.artifact?.id,
        downloadUrl: result.downloadUrl,
      };
    }),
  );
  if (steps.at(-1).status === "failed") return { ok: false, steps, created };

  steps.push(
    await step("validate_completion", async () => {
      const result = await validateTicketCompletion(created.ticketId);
      return { ok: result.ok, checklist: result.checklist };
    }),
  );
  if (steps.at(-1).status === "failed") return { ok: false, steps, created };

  steps.push(
    await step("submit_done", async () => {
      const result = await submitDoneWithArtifacts({
        ticketId: created.ticketId,
        agentId: created.agentId,
        leaseToken: claim.lease.leaseToken,
        finalAgentSummary: "Objective self-test completed successfully.",
        actualFilesChanged: [`self-test/${run}.txt`],
      });
      return {
        ticketId: result.ticket.id,
        status: result.ticket.status,
        proofUrl: result.proofUrl,
        checklist: result.checklist,
      };
    }),
  );

  if (archive && created.projectId) {
    steps.push(
      await step("archive_test_data", async () => {
        const result = await archiveProject({
          projectId: created.projectId,
          reason: "Archived by objective_self_test.",
          archiveTickets: true,
        });
        return { projectId: result.project.id, archivedTickets: result.archivedTickets };
      }),
    );
  }

  return {
    ok: steps.every((item) => item.status === "passed"),
    steps,
    created,
  };
}
