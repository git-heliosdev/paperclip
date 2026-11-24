# Verified legacy CLI recovery

This repair adds one proof to the existing stop gates: the controller can retain
a verified historical **no provider turn dispatched** receipt for an operator
cancelled, fully settled Codex CLI execution. It does not certify old action
outcomes. It is not a general override for a missing PID.

The proof requires the complete contiguous event inventory and durable executor
settlement, no invocation or other non-lifecycle events, no provider output,
no process/session identity, no environment lease or finalization coordinator,
an expired controller lease, stable historical CLI configuration, and no task
adapter override or account-router selection. ACP and unknown cases stay held.

There is no new HTTP/MCP endpoint, key, grant, socket mount or provider command.
The existing trusted Docker operator invokes `scripts/verify-legacy-cli-stop.py`
with `inspect` or `record`, a rollout-manifest directory and an exact four-ID
scope JSON file. The wrapper observes the running historical controller's
immutable image, start time, unmounted/unmodified code and four reviewed source
blob hashes. A one-shot service using the reviewed candidate image independently
checks those source files and the database facts before retaining a typed proof
on the existing source-scoped recovery action. That write preserves task status,
recovery outcome, saved inputs and unknown action outcomes.

The two stop gates consume the typed proof only if its source binding and fresh
fact digest still match. The existing legacy acknowledged-stop proof is shared;
native process proofs, live PID/group checks, remote cleanup receipts,
coordinator ownership, task ownership, approvals, workspace recovery, and
explicit new-input authorization remain in place.

Historical contract: installed image
`sha256:165ef7671ee5bde31ad28140b6fd45cd70594da48e10b9cb363c1fe8c4098472`.
Its Codex source blob `581f1384f4c10501d01f2cbdcb866686eec1283c` differs from
repository blob `b21bbbea474984f067967ff72eb10bd6423254b9` only by removing the
project-provisioning bridge route import and argument. This existing difference
is preserved. It does not change awaited metadata persistence before the CLI
provider-turn process call. The earlier observability `codex --version` preflight
is not claimed absent. The source contract is deliberately pinned; another
historical image requires a separate review.

Build the overlay only over the exact locally tagged base. It recompiles only
the five changed/new service modules, then regenerates the existing runtime
bundle from the preserved compiled tree. No migration or default-branch merge
is required. Preserve every existing Compose input; render-check that only the
controller image changes, retain an immutable rollback and require a quiet
execution window. Verify runtime/security settings and original input hashes
after replacement, then let the same saved input continue through normal
admission. Assignees retain task closure and downstream delivery ownership.

The installed image uses user `node`. Its runtime bundle is root-owned. The
overlay uses root only while it writes build artifacts, then restores `USER node`
in the final image. Runtime user, capabilities, mounts and security settings
must match the deployed baseline. The first attempt without the build user
switch failed with EACCES while replacing the bundle; no live service changed.
