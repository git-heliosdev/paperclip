import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import {
  activityLog,
  agentConfigRevisions,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import type { LegacyNoProviderTurnProofFacts } from "./legacy-no-provider-turn-proof.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasKeyDeep(entry, key));
  const row = record(value);
  return row ? Object.entries(row).some(([k, v]) => k === key || hasKeyDeep(v, key)) : false;
}

function cliConfig(config: unknown): boolean {
  const row = record(config);
  const adapter = record(row?.adapterConfig);
  return row?.adapterType === "codex_local" && adapter?.engine === "cli" && adapter?.command === "codex";
}

function hasOutputMetadata(run: Run): boolean {
  const result = record(run.resultJson);
  return run.lastOutputAt !== null || run.lastOutputSeq !== 0 || run.lastOutputStream !== null ||
    run.lastOutputBytes !== null && run.lastOutputBytes !== 0 ||
    run.logBytes !== null && run.logBytes !== 0 || run.logSha256 !== null ||
    ["stdout", "stderr", "stdoutExcerpt", "stderrExcerpt", "output", "logBytes", "logSha256"]
      .some((key) => result?.[key] !== null && result?.[key] !== undefined && result?.[key] !== "" && result?.[key] !== 0);
}

/**
 * Collects immutable and current DB facts for one exact run. `sourceSemanticsProven`
 * must only be true after the operator's pinned-source verification receipt has
 * been validated by the caller. This function never writes or infers that receipt.
 */
export async function collectLegacyNoProviderTurnFacts(
  db: Db,
  run: Run,
  sourceSemanticsProven = false,
  now = new Date(),
): Promise<LegacyNoProviderTurnProofFacts | null> {
  const [stored] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.agentId, run.agentId),
  )).limit(1);
  if (!stored || !stored.startedAt || !stored.finishedAt || stored.finishedAt < stored.startedAt) return null;
  // A pre-dispatch proof is small. Reject a large/ambiguous history before
  // loading it on a shared admission path. Never truncate an event inventory.
  if (!Number.isSafeInteger(stored.nextEventSeq) || stored.nextEventSeq < 2 || stored.nextEventSeq > 64) return null;

  const contextIssueId = record(stored.contextSnapshot)?.issueId;
  const issueIds = [stored.nativeIssueId, stored.issueId, typeof contextIssueId === "string" ? contextIssueId : null]
    .filter((value): value is string => typeof value === "string");
  if (issueIds.some((id) => id !== issueIds[0])) return null;
  const issueId = issueIds[0] ?? null;
  if (!issueId) return null;
  const [issue] = await db.select().from(issues).where(and(
    eq(issues.companyId, stored.companyId), eq(issues.id, issueId), eq(issues.assigneeAgentId, stored.agentId),
  )).limit(1);
  if (!issue || issue.createdAt > stored.startedAt || issue.assigneeAdapterOverrides !== null) return null;

  const issueActivity = await db.select({ action: activityLog.action, details: activityLog.details, createdAt: activityLog.createdAt })
    .from(activityLog).where(and(eq(activityLog.companyId, stored.companyId), eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issue.id))).orderBy(asc(activityLog.createdAt));
  const issueCreated = issueActivity.some((entry) => entry.action === "issue.created" && entry.createdAt <= stored.createdAt);
  const overrideHistoryComplete = issueCreated && issueActivity.every((entry) => !hasKeyDeep(entry.details, "assigneeAdapterOverrides"));

  const [effective] = await db.select().from(agentConfigRevisions).where(and(
    eq(agentConfigRevisions.companyId, stored.companyId), eq(agentConfigRevisions.agentId, stored.agentId),
    lte(agentConfigRevisions.createdAt, stored.createdAt),
  )).orderBy(desc(agentConfigRevisions.createdAt)).limit(1);
  const during = await db.select().from(agentConfigRevisions).where(and(
    eq(agentConfigRevisions.companyId, stored.companyId), eq(agentConfigRevisions.agentId, stored.agentId),
    gt(agentConfigRevisions.createdAt, stored.createdAt),
    lte(agentConfigRevisions.createdAt, stored.finishedAt),
  )).orderBy(asc(agentConfigRevisions.createdAt));
  const revisions = effective ? [effective, ...during] : during;
  const stable = Boolean(effective && cliConfig(effective.afterConfig) && during.every((revision) =>
    cliConfig(revision.beforeConfig) && cliConfig(revision.afterConfig)));

  const events = await db.select({ agentId: heartbeatRunEvents.agentId, seq: heartbeatRunEvents.seq, eventType: heartbeatRunEvents.eventType,
    message: heartbeatRunEvents.message, payload: heartbeatRunEvents.payload, createdAt: heartbeatRunEvents.createdAt })
    .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, stored.companyId), eq(heartbeatRunEvents.runId, stored.id)))
    .orderBy(asc(heartbeatRunEvents.seq));
  const eventInventoryComplete = Number.isSafeInteger(stored.nextEventSeq) && stored.nextEventSeq >= 1 &&
    events.length === stored.nextEventSeq - 1 && events.every((event, index) => event.agentId === stored.agentId && event.seq === index + 1);
  const durableSettlement = events.some((event) => {
    const payload = record(event.payload);
    return event.eventType === "lifecycle" && event.message === "task.run.measured" &&
      event.createdAt >= stored.finishedAt! && payload?.phase === "task.run.measured" &&
      payload?.outcome === "cancelled" && payload?.durableSettlement === true;
  });

  const [lease] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, stored.companyId), eq(environmentLeases.heartbeatRunId, stored.id),
  )).limit(1);
  const [coordinator] = await db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, stored.companyId), eq(nativeRunFinalizations.runId, stored.id),
  )).limit(1);

  const result = record(stored.resultJson);
  const cancellation = record(result?.cancellation);
  const dispatch = record(record(stored.runnerProfileJson)?.adapterDispatch);
  const routerSelectionPresent = hasKeyDeep(stored.contextSnapshot, "aiRouterSelection") ||
    hasKeyDeep(stored.runnerProfileJson, "aiRouterSelection") || hasKeyDeep(issueActivity, "aiRouterSelection") ||
    revisions.some((revision) => hasKeyDeep(revision.afterConfig, "aiRouterSelection"));
  return {
    binding: { companyId: stored.companyId, runId: stored.id, agentId: stored.agentId, issueId },
    run: {
      runtimeMode: stored.runtimeMode,
      status: stored.status,
      executionStage: stored.executionStage,
      startedAt: stored.startedAt,
      finishedAt: stored.finishedAt,
      processPid: stored.processPid,
      processGroupId: stored.processGroupId,
      nativeSessionId: stored.nativeSessionId,
      sessionIdAfter: stored.sessionIdAfter,
      cancellationSource: cancellation?.source === "operator" ? "operator" : null,
      cancellationExpected: cancellation?.expected === true,
      cancelledByActorType: result?.cancelledByActorType === "user" && typeof result.cancelledByUserId === "string" ? "user" : null,
      adapterType: dispatch?.adapterType === "codex_local" ? "codex_local" : null,
      routerSelectionPresent,
      controllerLeaseExpired: stored.controllerLeaseExpiresAt === null || stored.controllerLeaseExpiresAt <= now,
    },
    effectiveConfig: {
      adapterType: effective && cliConfig(effective.afterConfig) ? "codex_local" : null,
      engine: effective && cliConfig(effective.afterConfig) ? "cli" : null,
      command: effective && cliConfig(effective.afterConfig) ? "codex" : null,
      agentConfigStable: stable,
      issueAdapterOverridesAbsent: issue.assigneeAdapterOverrides === null,
      issueOverrideHistoryComplete: overrideHistoryComplete,
      sourceSemanticsProven,
    },
    eventInventoryComplete,
    durableSettlement,
    events: events.map((event) => {
      const payload = record(event.payload);
      return { seq: event.seq, eventType: event.eventType, durableSettlement:
        event.eventType === "lifecycle" && event.message === "task.run.measured" &&
        event.createdAt >= stored.finishedAt! && payload?.phase === "task.run.measured" &&
        payload?.outcome === "cancelled" && payload?.durableSettlement === true };
    }),
    hasProviderOutputOrLogMetadata: hasOutputMetadata(stored),
    hasRemoteOrUnreleasedLease: Boolean(lease),
    hasCoordinatorOwnerOrSuccessor: Boolean(coordinator),
  };
}
