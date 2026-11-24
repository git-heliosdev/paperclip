/**
 * A narrow proof for a cancelled legacy Codex CLI run whose remote SSH
 * transport reports no process identity. This says only that the provider
 * turn was never launched; it does not attest an action outcome.
 *
 * The caller must build these facts from immutable run/config history and
 * server-owned event rows. Missing or ambiguous history must map to false.
 */
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
  /** Effective values reconstructed from config revisions at run start. */
  effectiveConfig: {
    adapterType: string | null;
    engine: string | null;
    command: string | null;
    agentConfigStable: boolean;
    issueAdapterOverridesAbsent: boolean;
    issueOverrideHistoryComplete: boolean;
    /** Historical runs must be tied to the source version whose ordering is proven. */
    sourceSemanticsProven: boolean;
  };
  /** Event inventory for this exact company/run, from server-owned rows. */
  eventInventoryComplete: boolean;
  durableSettlement: boolean;
  events: Array<{ eventType: string; seq: number; durableSettlement: boolean }>;
  hasProviderOutputOrLogMetadata: boolean;
  hasRemoteOrUnreleasedLease: boolean;
  hasCoordinatorOwnerOrSuccessor: boolean;
};

const LIFECYCLE_EVENT = "lifecycle";

/**
 * Returns true only when durable source facts show that the Codex CLI turn
 * boundary was never crossed. Codex ACP is excluded because its session may
 * start before it emits adapter.invoke metadata.
 */
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
