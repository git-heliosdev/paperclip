import { describe, expect, it } from "vitest";
import {
  hasLegacyCodexCliNoProviderTurnProof,
  type LegacyNoProviderTurnProofFacts,
} from "./legacy-no-provider-turn-proof.js";

function validFacts(): LegacyNoProviderTurnProofFacts {
  return {
    binding: { companyId: "company", runId: "run", agentId: "agent", issueId: "issue", controllerBootId: null },
    run: {
      runtimeMode: "legacy",
      status: "cancelled",
      executionStage: "settled",
      startedAt: new Date("2026-11-24T02:21:00Z"),
      finishedAt: new Date("2026-11-24T02:29:00Z"),
      processPid: null,
      processGroupId: null,
      nativeSessionId: null,
      sessionIdAfter: null,
      cancellationSource: "operator",
      cancellationExpected: true,
      cancelledByActorType: "user",
      adapterType: "codex_local",
      routerSelectionPresent: false,
      controllerLeaseExpired: true,
    },
    effectiveConfig: {
      adapterType: "codex_local",
      engine: "cli",
      command: "codex",
      agentConfigStable: true,
      issueAdapterOverridesAbsent: true,
      issueOverrideHistoryComplete: true,
      sourceSemanticsProven: true,
    },
    eventInventoryComplete: true,
    durableSettlement: true,
    events: [{ eventType: "lifecycle", seq: 1, durableSettlement: false }, { eventType: "lifecycle", seq: 2, durableSettlement: true }],
    hasProviderOutputOrLogMetadata: false,
    hasRemoteOrUnreleasedLease: false,
    hasCoordinatorOwnerOrSuccessor: false,
  };
}

describe("legacy Codex CLI no-provider-turn proof", () => {
  it("accepts an exact settled operator-cancelled CLI run with no invocation evidence", () => {
    expect(hasLegacyCodexCliNoProviderTurnProof(validFacts())).toBe(true);
  });

  it.each([
    ["ACP", (f: LegacyNoProviderTurnProofFacts) => { f.effectiveConfig.engine = "acp"; }],
    ["unknown engine", (f: LegacyNoProviderTurnProofFacts) => { f.effectiveConfig.engine = null; }],
    ["adapter invocation", (f: LegacyNoProviderTurnProofFacts) => { f.events.push({ eventType: "adapter.invoke", seq: 3, durableSettlement: false }); }],
    ["provider turn", (f: LegacyNoProviderTurnProofFacts) => { f.events.push({ eventType: "turn.started", seq: 3, durableSettlement: false }); }],
    ["incomplete event inventory", (f: LegacyNoProviderTurnProofFacts) => { f.eventInventoryComplete = false; }],
    ["missing durable settlement", (f: LegacyNoProviderTurnProofFacts) => { f.durableSettlement = false; }],
    ["sequence gap", (f: LegacyNoProviderTurnProofFacts) => { f.events[1]!.seq = 4; }],
    ["unknown event type", (f: LegacyNoProviderTurnProofFacts) => { f.events.push({ eventType: "future.event", seq: 3, durableSettlement: false }); }],
    ["no settlement evidence", (f: LegacyNoProviderTurnProofFacts) => { f.events[1]!.durableSettlement = false; f.durableSettlement = false; }],
    ["agent config drift", (f: LegacyNoProviderTurnProofFacts) => { f.effectiveConfig.agentConfigStable = false; }],
    ["issue override", (f: LegacyNoProviderTurnProofFacts) => { f.effectiveConfig.issueAdapterOverridesAbsent = false; }],
    ["incomplete override history", (f: LegacyNoProviderTurnProofFacts) => { f.effectiveConfig.issueOverrideHistoryComplete = false; }],
    ["unverified source semantics", (f: LegacyNoProviderTurnProofFacts) => { f.effectiveConfig.sourceSemanticsProven = false; }],
    ["provider output or metadata", (f: LegacyNoProviderTurnProofFacts) => { f.hasProviderOutputOrLogMetadata = true; }],
    ["router selection", (f: LegacyNoProviderTurnProofFacts) => { f.run.routerSelectionPresent = true; }],
    ["live pid", (f: LegacyNoProviderTurnProofFacts) => { f.run.processPid = 42; }],
    ["session identity", (f: LegacyNoProviderTurnProofFacts) => { f.run.sessionIdAfter = "session"; }],
    ["lease authority", (f: LegacyNoProviderTurnProofFacts) => { f.hasRemoteOrUnreleasedLease = true; }],
    ["coordinator authority", (f: LegacyNoProviderTurnProofFacts) => { f.hasCoordinatorOwnerOrSuccessor = true; }],
    ["unsettled stage", (f: LegacyNoProviderTurnProofFacts) => { f.run.executionStage = "dispatching"; }],
    ["non-operator cancellation", (f: LegacyNoProviderTurnProofFacts) => { f.run.cancellationSource = "provider"; }],
  ] as const)("fails closed for %s", (_label, change) => {
    const facts = validFacts();
    change(facts);
    expect(hasLegacyCodexCliNoProviderTurnProof(facts)).toBe(false);
  });
});
