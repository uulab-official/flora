import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,chmod,rm,symlink} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import * as module from "../dist/index.js";
const api=module as unknown as {readRunnerConfig(path:string):Promise<unknown>};
test("machine credential config requires a private regular file and rejects execution overrides",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-config-"));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,"runner.json"),config={origin:"https://flora.example.test",token:"runner_fixture."+"a".repeat(43),dockerImage:"node@sha256:"+"a".repeat(64)};
 await writeFile(path,JSON.stringify(config));await chmod(path,0o644);await assert.rejects(api.readRunnerConfig(path));await chmod(path,0o600);assert.deepEqual(await api.readRunnerConfig(path),config);
 await writeFile(path,JSON.stringify({...config,executor:"host"}));await assert.rejects(api.readRunnerConfig(path));await writeFile(path,JSON.stringify(config));const alias=join(root,"alias.json");await symlink(path,alias);await assert.rejects(api.readRunnerConfig(alias));
});
test("hosted configuration requires explicit bounded resource and remote recovery profiles",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-hosted-config-"));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,"runner.json"),config={origin:"https://flora.example.test",token:"runner_fixture."+"a".repeat(43),dockerImage:"sha256:"+"a".repeat(64),resourceProfile:"github-hosted",dependencyPreparation:"npm-registry",publicationRecovery:"remote-checkpoint",claimPlatform:"android"};
 await writeFile(path,JSON.stringify(config),{mode:0o600});assert.deepEqual(await api.readRunnerConfig(path),config);
 const pnpm={...config,dependencyPreparation:"pnpm-registry"};await writeFile(path,JSON.stringify(pnpm));assert.deepEqual(await api.readRunnerConfig(path),pnpm);
 for(const admitted of [config,pnpm])for(const overrides of [{claimPlatform:"web"},{claimPlatform:["ios","android"]},{resourceProfile:"unlimited"},{resourceProfile:"default"},{dockerNetwork:"registry-egress"},{publicationRecovery:"ignore"},{dependencyPreparation:"host-install"}]){await writeFile(path,JSON.stringify({...admitted,...overrides}));await assert.rejects(api.readRunnerConfig(path),/INVALID_RUNNER_CONFIG/);}
});
