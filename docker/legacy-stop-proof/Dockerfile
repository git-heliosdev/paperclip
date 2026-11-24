# Operator overlay: reuse the exact installed controller, including its existing
# compiled adapters and unrelated release overlays. Never pull a new base.
FROM paperclip-legacy-cli-stop-base:165ef7671ee5
USER root
COPY server/ /app/server/
COPY packages/ /app/packages/
RUN cd /app/server && node --input-type=module -e 'import {transform} from "esbuild"; import {readFile,writeFile} from "node:fs/promises"; for (const name of ["agent-execution-stop","explicit-native-continuation","legacy-local-stop-proof","legacy-no-provider-turn-evidence","legacy-no-provider-turn-proof"]) { const result=await transform(await readFile(`src/services/${name}.ts`,"utf8"),{loader:"ts",format:"esm",target:"node24"}); await writeFile(`dist/services/${name}.js`,result.code); }' && node scripts/bundle-runtime.mjs
USER node
