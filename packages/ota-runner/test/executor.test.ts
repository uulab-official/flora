import test from "node:test";
import assert from "node:assert/strict";
import * as module from "../dist/index.js";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDockerExecutor, encodeExport, finishExport, assetMetadata } from "../dist/index.js";
import type { AutomationJob } from "@app-ops/dogfood";
const api = module as unknown as { dockerArguments(image:string,name:string,source:string,runner:string):string[] };
test("untrusted app execution requires a pinned image with no privileged mounts and bounded resources",()=>{
 assert.throws(()=>api.dockerArguments("node:latest","flora-test","/tmp/source","/tmp/runner"));
 const args=api.dockerArguments("node@sha256:"+"a".repeat(64),"flora-test","/tmp/source","/tmp/runner");
 assert.ok(args.includes("--read-only") && args.includes("--cap-drop=ALL") && args.includes("--security-opt=no-new-privileges") && args.includes("--pids-limit=128"));
 assert.ok(args.includes("--memory=1073741824") && args.includes("--cpus=2") && args.includes(`--user=${process.getuid!()}:${process.getgid!()}`));
 assert.ok(args.includes("type=bind,src=/tmp/source,dst=/source,readonly"));
 assert.ok(!args.some(arg=>/docker\.sock|privileged|host|token/i.test(arg)));
});
test("Docker availability is distinct from invalid isolation configuration and cancellation",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-docker-verify-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const marker=join(root,"contacted"),executable=join(root,"docker");
 await writeFile(executable,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'called');process.stderr.write('never-log-secret');process.exitCode=1;\n`,{mode:0o755});
 const valid={image:"node@sha256:"+"a".repeat(64),executable};
 for(const change of [{image:"node:latest"},{network:"host"},{resourceProfile:"unsafe"}]){
  await assert.rejects(createDockerExecutor({...valid,...change} as Parameters<typeof createDockerExecutor>[0]).verify(),/^Error: ISOLATION_UNAVAILABLE$/);
  const {lstat}=await import("node:fs/promises");await assert.rejects(lstat(marker),{code:"ENOENT"});
 }
 await assert.rejects(createDockerExecutor(valid).verify(),/^Error: DOCKER_DAEMON_UNAVAILABLE$/);
 const controller=new AbortController();controller.abort();await assert.rejects(createDockerExecutor(valid).verify(controller.signal),/^Error: RUNNER_STOPPED$/);
});
for(const success of [true,false])test(`unconfirmed Docker cleanup stops ${success?"successful":"failed"} export`,async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-docker-control-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const expectation={platform:"ios" as const,runtimeVersion:"native-1",commitSha:"a".repeat(40)},output=encodeExport(finishExport(expectation,assetMetadata("launch","bundle",new TextEncoder().encode("fixture")),[]));
 const executable=join(root,"docker");await writeFile(executable,`#!${process.execPath}\nconst command=process.argv[2];if(command==='version'){process.stdout.write('test');}else if(command==='run'){${success?`process.stdout.write(${JSON.stringify(output)});`:"process.exitCode=1;"}}else if(command==='rm'){process.exitCode=1;}else if(command==='container'){process.stdout.write('still-running');}else{process.exitCode=1;}\n`);await chmod(executable,0o755);
 const executor=createDockerExecutor({image:"node@sha256:"+"a".repeat(64),executable});
 await assert.rejects(executor.execute({...expectation,config:{},rootDirectory:"."} as AutomationJob,root,new AbortController().signal),/ISOLATION_CLEANUP_UNCONFIRMED/);
});
test("confirmed absent container preserves original export failure",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-docker-absent-"));t.after(()=>rm(root,{recursive:true,force:true}));const executable=join(root,"docker");
 await writeFile(executable,`#!${process.execPath}\nif(process.argv[2]==='version')process.stdout.write('test');else if(process.argv[2]==='container'){}else process.exitCode=1;\n`);await chmod(executable,0o755);
 await assert.rejects(createDockerExecutor({image:"node@sha256:"+"a".repeat(64),executable}).execute({platform:"ios",runtimeVersion:"native-1",commitSha:"a".repeat(40),config:{},rootDirectory:"."} as AutomationJob,root,new AbortController().signal),/EXPORT_FAILED/);
});
