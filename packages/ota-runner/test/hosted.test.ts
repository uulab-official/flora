import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as module from "../dist/index.js";
const api=module as unknown as {
 dockerArguments(image:string,name:string,source:string,helper:string,network?:string,profile?:string,cache?:string):string[];
 dockerCacheArguments(image:string,name:string,seed:string,helper:string,cache:string,profile:string):string[];
 prepareNpmDependencySeed(source:string,rootDirectory:string,destination:string):Promise<void>;
};
test("container exporter uses a deletable child directory below the bounded output mount",()=>{
 assert.equal((module as unknown as {CONTAINER_EXPORT_DIRECTORY?:string}).CONTAINER_EXPORT_DIRECTORY,"/output/export");
});
test("GitHub profile accepts only immutable images and keeps the compiler offline with bounded mounts",()=>{
 const args=api.dockerArguments("sha256:"+"a".repeat(64),"flora-hosted","/source","/helper","none","github-hosted","/private/cache");
 assert.ok(args.includes("--memory=4294967296")&&args.includes("--memory-swap=4294967296")&&args.includes("--cpus=2")&&args.includes("--pull=never"));
 assert.ok(args.some(arg=>arg.startsWith("--tmpfs=/workspace:")&&arg.includes("size=3221225472")));
 assert.ok(args.some(arg=>arg.startsWith("--tmpfs=/workspace:rw,exec,nosuid,nodev,")));
 assert.ok(args.includes("--network=none")&&args.includes("type=bind,src=/private/cache,dst=/dependency-cache,readonly"));
 assert.throws(()=>api.dockerArguments("node:24","flora-hosted","/source","/helper","none","github-hosted"));
 assert.throws(()=>api.dockerArguments("sha256:"+"a".repeat(64),"flora-hosted","/source","/helper","none","unlimited"));
 const seed=api.dockerCacheArguments("sha256:"+"a".repeat(64),"flora-seed","/seed","/helper","/private/cache","github-hosted");
 assert.ok(seed.includes("--network=bridge"));
 assert.ok(seed.some(arg=>arg.startsWith("--tmpfs=/workspace:rw,noexec,nosuid,nodev,")));
 assert.ok(seed.includes("type=bind,src=/seed,dst=/seed,readonly")&&seed.includes("type=bind,src=/private/cache,dst=/dependency-cache"));
 assert.ok(!seed.some(arg=>arg.includes("dst=/source")||/docker\.sock|token|privileged/.test(arg)));
});
async function fixture(t:{after(fn:()=>Promise<unknown>):void}){
 const directory=await mkdtemp(join(tmpdir(),"flora-npm-seed-"));t.after(()=>rm(directory,{recursive:true,force:true}));
 const source=join(directory,"source"),seed=join(directory,"seed");await mkdir(join(source,"vendor"),{recursive:true});
 const bytes=Buffer.from("vendor fixture"),integrity="sha512-"+createHash("sha512").update(bytes).digest("base64");
 const pkg={name:"fixture",version:"1.0.0",private:true,dependencies:{"@flora/ota":"file:vendor/flora.tgz",react:"19.2.3"},scripts:{postinstall:"touch /should-not-run"},config:{registry:"https://attacker.test"},main:"index.js"};
 const lock={name:"fixture",version:"1.0.0",lockfileVersion:3,packages:{"":{name:"fixture",version:"1.0.0",dependencies:pkg.dependencies},"node_modules/@flora/ota":{version:"0.3.1",resolved:"file:vendor/flora.tgz",integrity},"node_modules/react":{version:"19.2.3",resolved:"https://registry.npmjs.org/react/-/react-19.2.3.tgz",integrity:"sha512-"+Buffer.alloc(64,1).toString("base64")}}};
 await writeFile(join(source,"package.json"),JSON.stringify(pkg));await writeFile(join(source,"package-lock.json"),JSON.stringify(lock));await writeFile(join(source,"vendor/flora.tgz"),bytes);
 await writeFile(join(source,".npmrc"),"registry=https://attacker.test\n");await writeFile(join(source,"index.js"),"throw new Error('app source must not enter seed')");
 return {source,seed,lock};
}
test("online dependency seed contains only audited manifests and integrity-verified vendor bytes",async t=>{
 const f=await fixture(t);await api.prepareNpmDependencySeed(f.source,".",f.seed);
 assert.deepEqual((await readdir(f.seed)).sort(),["package-lock.json","package.json","vendor"]);
 const pkg=JSON.parse(await readFile(join(f.seed,"package.json"),"utf8"));assert.equal(pkg.scripts,undefined);assert.equal(pkg.config,undefined);assert.equal(pkg.main,undefined);assert.deepEqual(pkg.dependencies,{"@flora/ota":"file:vendor/flora.tgz",react:"19.2.3"});
 assert.equal((await readFile(join(f.seed,"vendor/flora.tgz"))).toString(),"vendor fixture");
});
for(const resolved of ["https://attacker.test/react.tgz","https://registry.npmjs.org.evil.test/react.tgz","https://user:password@registry.npmjs.org/react/-/react.tgz","https://registry.npmjs.org/react/-/react.tgz?token=secret","git+https://github.com/user/repo.git","file:../secret.tgz"]){
 test("dependency preparation rejects foreign or ambiguous resolved origin: "+resolved,async t=>{
  const f=await fixture(t);f.lock.packages["node_modules/react"].resolved=resolved;await writeFile(join(f.source,"package-lock.json"),JSON.stringify(f.lock));await assert.rejects(api.prepareNpmDependencySeed(f.source,".",f.seed),/DEPENDENCY_CACHE_INVALID/);
 });
}
test("dependency preparation rejects changed vendor bytes and symlink input",async t=>{
 const f=await fixture(t);await writeFile(join(f.source,"vendor/flora.tgz"),"changed");await assert.rejects(api.prepareNpmDependencySeed(f.source,".",f.seed),/DEPENDENCY_CACHE_INVALID/);
 const g=await fixture(t);await rm(join(g.source,"vendor/flora.tgz"));await symlink(join(g.source,"index.js"),join(g.source,"vendor/flora.tgz"));await assert.rejects(api.prepareNpmDependencySeed(g.source,".",g.seed),/DEPENDENCY_CACHE_INVALID/);
});
test("hosted executor runs sanitized online preparation then offline compiler and disposes both mounts",async t=>{
 const f=await fixture(t),log=join(f.source,"docker-calls.jsonl"),executable=join(f.source,"docker-control"),expectation={platform:"ios" as const,runtimeVersion:"flora-fixture",commitSha:"a".repeat(40)},output=module.encodeExport(module.finishExport(expectation,module.assetMetadata("launch","bundle",Buffer.from("actual controlled output")),[]));
 const program=`#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,secret:process.env.FLORA_TEST_UNFORWARDED})+'\\n');if(args[0]==='version')process.stdout.write('test');else if(args[0]==='run'){const seed=args.at(-1).endsWith('prepare-cache-container.js');if(seed){const mount=args.find(x=>x.includes('dst=/seed,'));const root=mount.split('src=')[1].split(',')[0],pkg=JSON.parse(fs.readFileSync(p.join(root,'package.json')));if(pkg.scripts||pkg.config||fs.existsSync(p.join(root,'.npmrc'))||fs.existsSync(p.join(root,'index.js')))process.exitCode=1;else process.stdout.write('FLORA_DEPENDENCY_CACHE_READY\\n');}else{let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const job=JSON.parse(input);if(!job.offline||!job.dependencyCache||input.includes('credential'))process.exitCode=1;else process.stdout.write(${JSON.stringify(output)});});}}else if(args[0]==='container'){}else if(args[0]!=='rm')process.exitCode=1;\n`;
 await writeFile(executable,program,{mode:0o755});const old=process.env.FLORA_TEST_UNFORWARDED;process.env.FLORA_TEST_UNFORWARDED="controller-credential-fixture";t.after(async()=>{if(old===undefined)delete process.env.FLORA_TEST_UNFORWARDED;else process.env.FLORA_TEST_UNFORWARDED=old;});
 const job={...expectation,appId:"app_fixture",channel:"flora-verification",rootDirectory:".",config:{runtimeVersion:expectation.runtimeVersion,toolchain:{nodeVersion:"24.19.0",packageManager:{name:"npm",version:"10.9.8"}}}} as import("@app-ops/dogfood").AutomationJob;
 const result=await module.createDockerExecutor({image:"sha256:"+"a".repeat(64),resourceProfile:"github-hosted",dependencyPreparation:"npm-registry",executable}).execute(job,f.source,new AbortController().signal);assert.equal(result.launchAsset.digest,module.sha256(Buffer.from("actual controlled output")));
 const calls=(await readFile(log,"utf8")).trim().split("\n").map(x=>JSON.parse(x) as {args:string[];secret?:string});assert.ok(calls.every(call=>call.secret===undefined));const runs=calls.filter(call=>call.args[0]==="run");assert.equal(runs.length,2);assert.ok(runs[0]!.args.includes("--network=bridge")&&runs[1]!.args.includes("--network=none"));
 const cacheMount=runs[0]!.args.find(x=>x.includes("dst=/dependency-cache"))!,cache=cacheMount.split("src=")[1]!.split(",")[0]!;await assert.rejects(lstat(cache),{code:"ENOENT"});
});
