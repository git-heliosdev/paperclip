FROM paperclip-legacy-cli-stop-base:165ef7671ee5
USER root
COPY server/src/services/agent-execution-stop.ts server/src/services/explicit-native-continuation.ts server/src/services/legacy-local-stop-proof.ts server/src/services/legacy-no-provider-turn-evidence.ts server/src/services/legacy-no-provider-turn-proof.ts server/src/services/legacy-no-provider-turn-proof.test.ts server/src/services/legacy-no-provider-turn-evidence.postgres.test.ts /app/server/src/services/
COPY server/scripts/operator/verify-legacy-cli-stop.mjs /app/server/scripts/operator/
COPY packages/adapters/codex-local/src/server/execute.remote.test.ts /app/packages/adapters/codex-local/src/server/
COPY maps/feature-map/recovery.md /app/maps/feature-map/
COPY maps/agent-access-map/recovery.md /app/maps/agent-access-map/
COPY doc/legacy-cli-stop-verification.md /app/doc/
RUN cd /app/server && node --input-type=module -e 'import {transform} from "esbuild"; import {readFile,writeFile} from "node:fs/promises"; for (const name of ["agent-execution-stop","explicit-native-continuation","legacy-local-stop-proof","legacy-no-provider-turn-evidence","legacy-no-provider-turn-proof"]) { const result=await transform(await readFile(`src/services/${name}.ts`,"utf8"),{loader:"ts",format:"esm",target:"node24"}); await writeFile(`dist/services/${name}.js`,result.code); }' && node scripts/bundle-runtime.mjs
USER node
