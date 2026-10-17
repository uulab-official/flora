FROM node@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
# Only trusted toolchain preparation runs here. No repository source or secret
# is part of this build context or image.
RUN node --input-type=module -e 'import {writeFile} from "node:fs/promises"; import {createHash} from "node:crypto"; const r=await fetch("https://registry.npmjs.org/npm/-/npm-10.9.8.tgz",{redirect:"error",signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error("NPM_FETCH_FAILED");const b=Buffer.from(await r.arrayBuffer());if(b.length>16777216||createHash("sha512").update(b).digest("base64")!=="fYwb6ODSmHkqrJQQaCxY3M2lPf/mpgC7ik0HSzzIwG5CGtabRp4bNqikatvCoT42b5INQSqudVH0R7yVmC9hVg==")throw Error("NPM_INTEGRITY_FAILED");await writeFile("/tmp/npm.tgz",b);' \
 && npm install --global --ignore-scripts --no-audit --no-fund /tmp/npm.tgz \
 && rm -rf /tmp/npm.tgz /root/.npm \
 && test "$(node --version)" = "v24.19.0" \
 && test "$(npm --version)" = "10.9.8"
