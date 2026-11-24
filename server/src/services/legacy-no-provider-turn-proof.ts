
export type LegacyNoProviderTurnProofFacts = {
  binding: { companyId: string; runId: string; agentId: string; issueId: string };
  run: {
    runtimeMode: string | null;
    status: string;
    executionStage: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    processPid: number | null;
    processGroupId: number | null;
    nativeSessionId: string | null;
    sessionIdAfter: string | null;
    cancellationSource: string | null;
    cancellationExpected: boolean;
    cancelledByActorType: string | null;
    adapterType: string | null;
    routerSelectionPresent: boolean;
    controllerLeaseExpired: boolean;
  };
  
  effectiveConfig: {
    adapterType: string | null;
    engine: string | null;
    command: string | null;
    agentConfigStable: boolean;
    issueAdapterOverridesAbsent: boolean;
    issueOverrideHistoryComplete: boolean;
    
    sourceSemanticsProven: boolean;
  };
  
  eventInventoryComplete: boolean;
  durableSettlement: boolean;
  events: Array<{ eventType: string; seq: number; durableSettlement: boolean }>;
  hasProviderOutputOrLogMetadata: boolean;
  hasRemoteOrUnreleasedLease: boolean;
  hasCoordinatorOwnerOrSuccessor: boolean;
};

const LIFECYCLE_EVENT = "lifecycle";


export function hasLegacyCodexCliNoProviderTurnProof(
  facts: LegacyNoProviderTurnProofFacts,
): boolean {
  const { run, effectiveConfig } = facts;
  if (
    run.runtimeMode !== "legacy" ||
    run.status !== "cancelled" ||
    run.executionStage !== "settled" ||
    !run.startedAt ||
    !run.finishedAt ||
    run.processPid !== null ||
    run.processGroupId !== null ||
    run.nativeSessionId !== null ||
    run.sessionIdAfter !== null ||
    run.cancellationSource !== "operator" ||
    run.cancellationExpected !== true ||
    run.cancelledByActorType !== "user" ||
    run.adapterType !== "codex_local" ||
    effectiveConfig.adapterType !== "codex_local" ||
    effectiveConfig.engine !== "cli" ||
    effectiveConfig.command !== "codex" ||
    !effectiveConfig.agentConfigStable ||
    !effectiveConfig.issueAdapterOverridesAbsent ||
    !effectiveConfig.issueOverrideHistoryComplete ||
    !effectiveConfig.sourceSemanticsProven ||
    !facts.eventInventoryComplete ||
    !facts.durableSettlement ||
    !facts.events.some((event) => event.durableSettlement) ||
    run.routerSelectionPresent ||
    !run.controllerLeaseExpired ||
    facts.hasProviderOutputOrLogMetadata ||
    facts.hasRemoteOrUnreleasedLease ||
    facts.hasCoordinatorOwnerOrSuccessor ||
    facts.events.some((event, index) => event.eventType !== LIFECYCLE_EVENT || event.seq !== index + 1)
  ) {
    return false;
  }
  return true;
}
