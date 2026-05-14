---
name: objective
description: Use when the user asks Codex to track work in Objective, create or claim tickets, coordinate multiple agents, update implementation status, claim files before editing, record tests, attach proof artifacts, or complete tickets with evidence.
---

# Objective

Objective is a local ticketing system for AI agents. Treat it as the source of truth for agent work.

## Required Workflow

1. Read or create an Objective ticket before implementation.
2. Claim the ticket before starting work.
3. Claim files before editing them.
4. Keep planned files and actual changed files current.
5. Record every meaningful test after running it.
6. Attach proof artifacts before completion.
7. Submit `Done` only after the completion checklist passes.
8. Mark the ticket `Blocked` with a precise reason when unable to continue.

## Completion Gate

Do not attempt to complete a ticket unless Objective has:

- tests performed
- proof screenshot or artifact
- proof or test URL
- final agent summary
- actual files changed

The backend rejects incomplete tickets. Do not fake proof or use placeholder evidence.

## File Locks

Use `objective_claim_files` before editing. If Objective reports a conflict, do not edit those files. Pick another ticket, ask for direction, or wait until the lock expires.

## Proof

For UI work, attach a screenshot or computer-use/browser screenshot plus the local URL to inspect. For backend work, attach test logs or structured proof and a relevant local endpoint or command reference.

## Useful Tools

- `objective_list_projects` - defaults to 25 compact recent projects; use `q` to search noisy local stores.
- `objective_create_ticket`
- `objective_get_ticket`
- `objective_get_available_tickets`
- `objective_claim_ticket`
- `objective_claim_files`
- `objective_record_test`
- `objective_attach_artifact`
- `objective_validate_ticket_completion`
- `objective_submit_done`
- `objective_mark_blocked`
- `objective_get_ticket_events` - compact latest 25 events by default; set `includeData` when event payloads are needed.
