import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agentConfigRevisions, agents, companies, createDb, heartbeatRunEvents,
  heartbeatRuns, issues, issueRecoveryActions, issueComments, agentWakeupRequests, environmentLeases,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { collectLegacyNoProviderTurnFacts } from "./legacy-no-provider-turn-evidence.js";
import { hasLegacyCodexCliNoProviderTurnProof } from "./legacy-no-provider-turn-proof.js";
import { LEGACY_CLI_SOURCE_IMAGE, LEGACY_CLI_SOURCE_CONTRACT, recordLegacyCliPreDispatchStop, hasLegacyLocalStopProof } from "./legacy-local-stop-proof.js";
import { admitExplicitNativeContinuation } from "./explicit-native-continuation.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { agentExecutionsHaveStopped } from "./agent-execution-stop.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const started = new Date("2026-11-24T02:21:00.000Z");
const finished = new Date("2026-11-24T02:29:00.000Z");
const config = { adapterType: "codex_local", adapterConfig: { engine: "cli", command: "codex" } };

describePostgres("legacy no-provider-turn evidence collection", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("legacy-no-provider-turn-evidence-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed(options: { missingConfig?: boolean; eventGap?: boolean; issueOverride?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Legacy evidence", issuePrefix: `L${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "operator" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Testing", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: config.adapterConfig, runtimeConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Cancelled run", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: "operator", createdAt: new Date(started.getTime() - 60_000),
      ...(options.issueOverride ? { assigneeAdapterOverrides: { adapterConfig: { command: "other" } } } : {}) });
    await db.insert(activityLog).values({ companyId, actorType: "system", actorId: "system", action: "issue.created",
      entityType: "issue", entityId: issueId, createdAt: new Date(started.getTime() - 60_000), details: {} });
    if (!options.missingConfig) {
      await db.insert(agentConfigRevisions).values([
        { companyId, agentId, source: "initial", changedKeys: [], beforeConfig: config, afterConfig: config,
          createdAt: new Date(started.getTime() - 120_000) },
        { companyId, agentId, source: "patch", changedKeys: ["timeout"], beforeConfig: config, afterConfig: config,
          createdAt: new Date(started.getTime() + 60_000) },
      ]);
    }
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, invocationSource: "on_demand",
      status: "cancelled", runtimeMode: "legacy", executionStage: "settled", startedAt: started, finishedAt: finished,
      createdAt: new Date(started.getTime() - 30_000),
      contextSnapshot: { issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      errorCode: "cancelled", error: "Cancelled by a board operator",
      resultJson: { cancellation: { source: "operator", expected: true, initiator: { type: "user", id: "operator" },
        reason: "Cancelled by a board operator", recordedAt: finished.toISOString() },
        cancelledByActorType: "user", cancelledByUserId: "operator" },
      nextEventSeq: 3, lastOutputSeq: 0, logStore: "local_fs", logRef: "initialized-empty.log", logBytes: 0 }).returning();
    await db.insert(heartbeatRunEvents).values([
      { companyId, agentId, runId, seq: 1, eventType: "lifecycle", message: "task.run.started", payload: { phase: "task.run.started" }, createdAt: started },
      { companyId, agentId, runId, seq: options.eventGap ? 3 : 2, eventType: "lifecycle", message: "task.run.measured",
        payload: { phase: "task.run.measured", outcome: "cancelled", durableSettlement: true }, createdAt: new Date(finished.getTime() + 1) },
    ]);
    return { companyId, issueId, agentId, run: run! };
  }

  it("collects a complete exact-run fact set, with source semantics unproven by default", async () => {
    const f = await seed();
    const facts = await collectLegacyNoProviderTurnFacts(db, f.run);
    expect(facts?.effectiveConfig.sourceSemanticsProven).toBe(false);
    expect(facts?.eventInventoryComplete).toBe(true);
    expect(facts?.durableSettlement).toBe(true);
    expect(hasLegacyCodexCliNoProviderTurnProof(facts!)).toBe(false);
    const verified = await collectLegacyNoProviderTurnFacts(db, f.run, true);
    expect(hasLegacyCodexCliNoProviderTurnProof(verified!)).toBe(true);
  });

  it("fails closed without config history, with event gaps, or with issue overrides", async () => {
    const missingConfig = await seed({ missingConfig: true });
    const noConfigFacts = await collectLegacyNoProviderTurnFacts(db, missingConfig.run, true);
    expect(noConfigFacts?.effectiveConfig.agentConfigStable).toBe(false);
    expect(hasLegacyCodexCliNoProviderTurnProof(noConfigFacts!)).toBe(false);

    const eventGap = await seed({ eventGap: true });
    const gapFacts = await collectLegacyNoProviderTurnFacts(db, eventGap.run, true);
    expect(gapFacts?.eventInventoryComplete).toBe(false);
    expect(hasLegacyCodexCliNoProviderTurnProof(gapFacts!)).toBe(false);

    const override = await seed({ issueOverride: true });
    const overrideFacts = await collectLegacyNoProviderTurnFacts(db, override.run, true);
    expect(overrideFacts).toBeNull();
  });

  it("checks the CLI configuration through executor settlement after cancellation", async () => {
    const f = await seed();
    await db.update(heartbeatRunEvents).set({ createdAt: new Date(finished.getTime() + 120_000) }).where(and(
      eq(heartbeatRunEvents.runId, f.run.id), eq(heartbeatRunEvents.message, "task.run.measured")));
    await db.insert(agentConfigRevisions).values({ companyId: f.companyId, agentId: f.agentId, source: "patch",
      changedKeys: ["adapterConfig"], beforeConfig: config,
      afterConfig: { ...config, adapterConfig: { ...config.adapterConfig, engine: "acp" } },
      createdAt: new Date(finished.getTime() + 60_000) });
    const facts = await collectLegacyNoProviderTurnFacts(db, f.run, true);
    expect(facts?.effectiveConfig.agentConfigStable).toBe(false);
    expect(hasLegacyCodexCliNoProviderTurnProof(facts!)).toBe(false);
  });

  async function recoveryFixture() {
    const f = await seed();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: f.run.id,
      status: "resolved", outcome: "blocked", returnOwnerAgentId: f.agentId, ownerType: "board",
      nextAction: "Stopped without replay", evidence: { runId: f.run.id, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    }).returning();
    return { ...f, action: action!, input: { companyId: f.companyId, issueId: f.issueId, runId: f.run.id,
      recoveryActionId: action!.id, observation: { imageId: LEGACY_CLI_SOURCE_IMAGE, containerId: "a".repeat(64),
        containerStartedAt: "2026-11-23T09:48:08.818Z", appMountsAbsent: true, appDiffAbsent: true,
        sourceBlobs: { ...LEGACY_CLI_SOURCE_CONTRACT } } } };
  }

  it("retains a typed verified proof without closing or certifying the source, then admits new input once", async () => {
    const f = await recoveryFixture();
    expect(await hasLegacyLocalStopProof(db, f.run)).toBe(false);
    const receipt = await recordLegacyCliPreDispatchStop(db, f.input);
    expect(receipt.meaning).toBe("no_provider_turn_dispatched");
    expect(await recordLegacyCliPreDispatchStop(db, f.input)).toEqual(receipt);
    expect(await hasLegacyLocalStopProof(db, f.run)).toBe(true);
    const [held] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id));
    expect(held.status).toBe("resolved"); expect(held.outcome).toBe("blocked");
    expect(held.evidence.automaticRecovery).toEqual({ replay: "blocked", actionOutcome: "unknown" });
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task.status).toBe("todo");
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "operator", body: "Continue the verification using recorded evidence; preserve prior outcomes.",
      createdAt: new Date(finished.getTime() + 60_000) });
    const request = { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, commentId,
      actorType: "user", actorId: "operator", reason: "issue_commented", successorRunId: randomUUID() };
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.run.id, recoveryActionId: f.action.id });
    const [queue] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "operator", payload: { issueId: f.issueId,
        _paperclipWakeContext: { wakeCommentIds: [commentId] }, queuedCommentInterrupt: { actorId: "operator" } },
    }).returning();
    const automatic = await db.transaction(tx => admitExplicitNativeContinuation({ db: tx as unknown as typeof db,
      ...request, queuedCommentRequestId: queue!.id }));
    expect(automatic).toBeNull();
    const explicit = { ...request, queuedCommentInterruptId: queue!.id };
    const first = await db.transaction(tx => admitExplicitNativeContinuation({ db: tx as unknown as typeof db, ...explicit }));
    expect(first).toMatchObject({ previousRunId: f.run.id, commentId });
    const second = await db.transaction(tx => admitExplicitNativeContinuation({ db: tx as unknown as typeof db, ...explicit }));
    expect(second).toBeNull();
  });

  it("rechecks the controller identity even when the caller holds an old run snapshot", async () => {
    const f = await recoveryFixture();
    await recordLegacyCliPreDispatchStop(db, f.input);
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await hasLegacyLocalStopProof(db, f.run)).toBe(false);
  });

  it("rejects malformed source observations and invalidates a proof if invocation evidence appears", async () => {
    const f = await recoveryFixture();
    await expect(recordLegacyCliPreDispatchStop(db, { ...f.input, observation: { ...f.input.observation,
      containerStartedAt: null as unknown as string } })).rejects.toThrow("source_binding_mismatch");
    await expect(recordLegacyCliPreDispatchStop(db, { ...f.input, observation: { ...f.input.observation,
      sourceBlobs: {} } })).rejects.toThrow("source_binding_mismatch");
    await recordLegacyCliPreDispatchStop(db, f.input);
    await db.update(heartbeatRuns).set({ nextEventSeq: 4 }).where(eq(heartbeatRuns.id, f.run.id));
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId: f.run.id,
      seq: 3, eventType: "adapter.invoke", payload: { adapterType: "codex_local" } });
    expect(await hasLegacyLocalStopProof(db, f.run)).toBe(false);
  });

  it("keeps a verified stop after later reassignment while denying the old assignee's new continuation", async () => {
    const f = await recoveryFixture();
    await recordLegacyCliPreDispatchStop(db, f.input);
    expect(await hasLegacyLocalStopProof(db, f.run)).toBe(true);

    const nextAgentId = randomUUID();
    await db.insert(agents).values({ id: nextAgentId, companyId: f.companyId, name: "Next owner", role: "engineer",
      status: "idle", adapterType: "codex_local", adapterConfig: config.adapterConfig, runtimeConfig: {} });
    const futureOverride = { adapterConfig: { command: "another-command" } };
    await db.update(issues).set({ assigneeAgentId: nextAgentId, assigneeAdapterOverrides: futureOverride,
      updatedAt: new Date(finished.getTime() + 120_000) }).where(eq(issues.id, f.issueId));
    await db.insert(activityLog).values({ companyId: f.companyId, actorType: "user", actorId: "operator",
      action: "issue.updated", entityType: "issue", entityId: f.issueId,
      details: { changes: { assigneeAgentId: nextAgentId, assigneeAdapterOverrides: futureOverride } },
      createdAt: new Date(finished.getTime() + 120_000) });

    expect(await hasLegacyLocalStopProof(db, f.run)).toBe(true);
    const followUpId = randomUUID();
    await db.insert(issueComments).values({ id: followUpId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "operator", body: "Continue under the current task owner.",
      createdAt: new Date(finished.getTime() + 180_000) });
    const runsBefore = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
    const commentsBefore = await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId));
    const denied = await db.transaction(tx => admitExplicitNativeContinuation({
      db: tx as unknown as typeof db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      actorType: "user", actorId: "operator", reason: "issue_commented", commentId: followUpId, successorRunId: randomUUID(),
    }));
    expect(denied).toBeNull();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(runsBefore.length);
    expect(await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId))).toHaveLength(commentsBefore.length);
  });

  it("invalidates a historical stop proof when a run-bound lease appears later", async () => {
    const f = await recoveryFixture();
    await recordLegacyCliPreDispatchStop(db, f.input);
    expect(await hasLegacyLocalStopProof(db, f.run)).toBe(true);
    await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: f.run.id, status: "active" });
    expect(await hasLegacyLocalStopProof(db, f.run)).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
  });
});
