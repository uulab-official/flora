# Native ARM64 PC compiler; preserves the separate existing amd64 npm Runner.
FROM node@sha256:b75abb8396290a89c61cfafa80a153b5d660d89c786919cb6745fb0ccc3bb171
# Only trusted toolchain preparation runs here. No repository source or secret
# is part of this build context or image.
RUN node --input-type=module -e 'import {writeFile} from "node:fs/promises"; import {createHash} from "node:crypto"; const r=await fetch("https://registry.npmjs.org/npm/-/npm-10.9.8.tgz",{redirect:"error",signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error("NPM_FETCH_FAILED");const b=Buffer.from(await r.arrayBuffer());if(b.length>16777216||createHash("sha512").update(b).digest("base64")!=="fYwb6ODSmHkqrJQQaCxY3M2lPf/mpgC7ik0HSzzIwG5CGtabRp4bNqikatvCoT42b5INQSqudVH0R7yVmC9hVg==")throw Error("NPM_INTEGRITY_FAILED");await writeFile("/tmp/npm.tgz",b);' \
 && npm install --global --ignore-scripts --no-audit --no-fund /tmp/npm.tgz \
 && rm -rf /tmp/npm.tgz /root/.npm \
 && test "$(node --version)" = "v24.19.0" \
 && test "$(npm --version)" = "10.9.8"
# PNPM workspace compiler is a separate image; existing npm Runner image remains unchanged.
RUN node --input-type=module -e 'import {writeFile} from "node:fs/promises"; import {createHash} from "node:crypto"; const r=await fetch("https://registry.npmjs.org/pnpm/-/pnpm-11.10.0.tgz",{redirect:"error",signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error("PNPM_FETCH_FAILED");const b=Buffer.from(await r.arrayBuffer());if(b.length>33554432||createHash("sha512").update(b).digest("base64")!=="C3+LmAYAMZBMAX46QesYehbUDuuCm5XE+MsDaBdh/Eq1PdIZEVubRH9NzhoFohR2RGHn03AzkqnzL5URzoyGyA==")throw Error("PNPM_INTEGRITY_FAILED");await writeFile("/tmp/pnpm.tgz",b);' \
 && npm install --global --ignore-scripts --no-audit --no-fund /tmp/pnpm.tgz \
 && rm -rf /tmp/pnpm.tgz /root/.npm \
 && test "$(node --version)" = "v24.19.0" \
 && test "$(pnpm --version)" = "11.10.0"

RUN test "$(node -p process.arch)" = "arm64"
