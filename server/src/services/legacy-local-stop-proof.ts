import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { persistActivity } from "./activity-log.js";
import { collectLegacyNoProviderTurnFacts, collectLegacyNoProviderTurnExecutionFacts } from "./legacy-no-provider-turn-evidence.js";
import { hasLegacyCodexCliNoProviderTurnProof, type LegacyNoProviderTurnProofFacts } from "./legacy-no-provider-turn-proof.js";

type Run = typeof heartbeatRuns.$inferSelect;
const SCHEMA = "paperclip.legacy-cli-pre-dispatch-stop.v1";
export const LEGACY_CLI_SOURCE_IMAGE = "sha256:165ef7671ee5bde31ad28140b6fd45cd70594da48e10b9cb363c1fe8c4098472";
export const LEGACY_CLI_SOURCE_CONTRACT = {
  "packages/adapters/codex-local/src/server/execute.ts": "581f1384f4c10501d01f2cbdcb866686eec1283c",
  "server/src/services/heartbeat/run-output.ts": "249db52646e055dcfdc6279c80d0c27603368811",
  "server/src/services/heartbeat/runtime-execution.ts": "067b7fa1198c401cd41e316cc66aa522151b997c",
  "server/src/services/heartbeat.ts": "6472c6b86121af27f0a7f756dfe094b68e1feeaa",
} as const;

function object(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
function canonical(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, value]) => [k, canonical(value)]));
  return v;
}
function digest(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
}
export { digest as legacyCliStopFactsDigest };


export type LegacyCliSourceObservation = {
  imageId: string;
  containerId: string;
  containerStartedAt: string;
  appMountsAbsent: boolean;
  appDiffAbsent: boolean;
  sourceBlobs: Record<string, string>;
};

export async function verifyLegacyCliSourceContract(appRoot: string): Promise<void> {
  for (const [path, expected] of Object.entries(LEGACY_CLI_SOURCE_CONTRACT)) {
    const bytes = await readFile(join(appRoot, path));
    const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (actual !== expected) throw new Error("legacy_cli_source_contract_mismatch");
  }
}

function validObservation(observation: LegacyCliSourceObservation, run: Run): boolean {
  if (!observation || typeof observation.containerStartedAt !== "string" ||
      typeof observation.containerId !== "string") return false;
  const started = new Date(observation.containerStartedAt).getTime();
  const blobs = object(observation.sourceBlobs);
  return observation.imageId === LEGACY_CLI_SOURCE_IMAGE &&
    /^[a-f0-9]{64}$/.test(observation.containerId) && Number.isFinite(started) &&
    new Date(started).toISOString() === observation.containerStartedAt &&
    started <= run.createdAt.getTime() && observation.appMountsAbsent === true &&
    observation.appDiffAbsent === true && Object.keys(blobs).length === Object.keys(LEGACY_CLI_SOURCE_CONTRACT).length &&
    Object.entries(LEGACY_CLI_SOURCE_CONTRACT)
      .every(([path, hash]) => blobs[path] === hash);
}


export async function recordLegacyCliPreDispatchStop(db: Db, input: {
  runId: string;
  companyId: string;
  issueId: string;
  recoveryActionId: string;
  observation: LegacyCliSourceObservation;
}) {
  return db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const [action] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, input.recoveryActionId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).for("update");
    if (!issue || !action || !run || action.sourceIssueId !== issue.id ||
        action.cause !== "legacy_execution_requires_reconciliation" || action.evidence.runId !== run.id ||
        action.returnOwnerAgentId !== run.agentId || issue.assigneeAgentId !== run.agentId ||
        (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== issue.id || !validObservation(input.observation, run)) {
      throw new Error("legacy_cli_stop_source_binding_mismatch");
    }
    const facts = await collectLegacyNoProviderTurnFacts(tx as unknown as Db, run, true);
    if (!facts || !hasLegacyCodexCliNoProviderTurnProof(facts)) throw new Error("legacy_cli_no_dispatch_not_proven");
    const factsDigest = digest(facts);
    const previous = object(action.evidence.legacyCliPreDispatchStop);
    if (previous.schema === SCHEMA && previous.factsDigest === factsDigest && digest(previous.factsSnapshot) === factsDigest) return previous;
    if (Object.keys(previous).length) throw new Error("legacy_cli_stop_receipt_conflict");
    const receipt = {
      schema: SCHEMA, companyId: run.companyId, issueId: issue.id, runId: run.id, agentId: run.agentId,
      finishedAt: run.finishedAt!.toISOString(), controllerBootId: run.controllerBootId,
      factsDigest, factsSnapshot: canonical(facts), sourceObservation: input.observation, verifiedAt: new Date().toISOString(),
      meaning: "no_provider_turn_dispatched", previousActionOutcomes: "not_certified",
    };
    await tx.update(issueRecoveryActions).set({ evidence: { ...action.evidence, legacyCliPreDispatchStop: receipt }, updatedAt: new Date() }).where(eq(issueRecoveryActions.id, action.id));
    await persistActivity(tx as unknown as Db, { companyId: run.companyId, actorType: "system", actorId: "legacy-cli-stop-verifier",
      action: "issue.legacy_cli_pre_dispatch_stop_verified", entityType: "issue", entityId: issue.id, runId: run.id,
      details: { recoveryActionId: action.id, factsDigest, sourceImageId: input.observation.imageId,
        meaning: "no_provider_turn_dispatched", priorActionOutcomes: "not_certified" } });
    return receipt;
  });
}


export async function hasLegacyLocalStopProof(db: Db, run: Run): Promise<boolean> {
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled") return false;
  if (object(run.resultJson?.executionCancellation).state === "acknowledged") return true;
  const issueId = run.nativeIssueId ?? run.contextSnapshot?.issueId;
  if (typeof issueId !== "string" || !run.finishedAt) return false;
  const actions = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issueId)));
  for (const action of actions) {
    const receipt = object(action.evidence.legacyCliPreDispatchStop);
    if (action.evidence.runId !== run.id || action.cause !== "legacy_execution_requires_reconciliation" ||
        receipt.schema !== SCHEMA || receipt.companyId !== run.companyId || receipt.issueId !== issueId ||
        receipt.runId !== run.id || receipt.agentId !== run.agentId ||
        receipt.finishedAt !== run.finishedAt.toISOString() || receipt.controllerBootId !== run.controllerBootId ||
        receipt.meaning !== "no_provider_turn_dispatched" ||
        !validObservation(object(receipt.sourceObservation) as LegacyCliSourceObservation, run)) continue;
    const snapshot = object(receipt.factsSnapshot);
    if (digest(snapshot) !== receipt.factsDigest) continue;
    const execution = await collectLegacyNoProviderTurnExecutionFacts(db, run);
    if (!execution) continue;
    const facts = { ...execution, effectiveConfig: object(snapshot.effectiveConfig) } as LegacyNoProviderTurnProofFacts;
    if (hasLegacyCodexCliNoProviderTurnProof(facts) && digest(facts) === receipt.factsDigest) return true;
  }
  return false;
}
