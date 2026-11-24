import { createDb, heartbeatRuns } from '@paperclipai/db';
import { and, eq } from 'drizzle-orm';
import { verifyLegacyCliSourceContract, recordLegacyCliPreDispatchStop, legacyCliStopFactsDigest } from '../../dist/services/legacy-local-stop-proof.js';
import { collectLegacyNoProviderTurnFacts } from '../../dist/services/legacy-no-provider-turn-evidence.js';
import { hasLegacyCodexCliNoProviderTurnProof } from '../../dist/services/legacy-no-provider-turn-proof.js';

let text = '';
for await (const chunk of process.stdin) {
  text += chunk;
  if (text.length > 32768) throw new Error('request_too_large');
}
const request = JSON.parse(text);
if (!['inspect', 'record'].includes(request.mode) || !process.env.DATABASE_URL) throw new Error('invalid_operator_request');
for (const key of ['companyId', 'issueId', 'runId', 'recoveryActionId']) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request[key])) throw new Error('invalid_source_identity');
}
await verifyLegacyCliSourceContract('/app');
const db = createDb(process.env.DATABASE_URL);
try {
  if (request.mode === 'inspect') {
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, request.companyId), eq(heartbeatRuns.id, request.runId)));
    if (!run) throw new Error('source_run_not_found');
    const facts = await collectLegacyNoProviderTurnFacts(db, run, true);
    console.log(JSON.stringify({ mode: 'inspect', runId: run.id, eligible: facts !== null && hasLegacyCodexCliNoProviderTurnProof(facts),
      factsDigest: legacyCliStopFactsDigest(facts), facts }));
  } else {
    console.log(JSON.stringify({ mode: 'record', receipt: await recordLegacyCliPreDispatchStop(db, request) }));
  }
} finally {
  await db.$client.end();
}
