import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
async function api(){return import("../dist/pnpm-dependencies.js");}
async function fixture(t:{after(fn:()=>Promise<unknown>):void}){
 const directory=await mkdtemp(join(tmpdir(),"flora-pnpm-seed-"));t.after(()=>rm(directory,{recursive:true,force:true}));const source=join(directory,"source"),seed=join(directory,"seed");
 for(const p of ["apps/app/vendor","packages/contracts/src","patches"])await mkdir(join(source,p),{recursive:true});
 const vendor=Buffer.from("trusted SDK archive bytes"),patch=Buffer.from("diff --git a/index.js b/index.js\n"),hash=createHash("sha256").update(patch).digest("hex"),integrity="sha512-"+createHash("sha512").update(vendor).digest("base64");
 const root={name:"workspace",version:"1.0.0",private:true,packageManager:"pnpm@11.10.0",scripts:{postinstall:"touch /canary"}};
 const app={name:"@fixture/app",version:"1.0.0",dependencies:{"@fixture/contracts":"workspace:*",react:"^19.2.3","@flora/ota":"file:vendor/flora.tgz"},scripts:{postinstall:"touch /canary"},expo:{autolinking:{nativeModulesDir:"./modules"}}};
 const contract={name:"@fixture/contracts",version:"1.0.0",exports:"./src/index.ts"};
 const lock=`lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\npatchedDependencies:\n  react@19.2.3: ${hash}\nimporters:\n  .: {}\n  apps/app:\n    dependencies:\n      '@fixture/contracts':\n        specifier: workspace:*\n        version: link:../../packages/contracts\n      react:\n        specifier: ^19.2.3\n        version: 19.2.3(patch_hash=${hash})\n      '@flora/ota':\n        specifier: file:vendor/flora.tgz\n        version: file:apps/app/vendor/flora.tgz(react@19.2.3)\n  packages/contracts: {}\npackages:\n  react@19.2.3:\n    resolution: {integrity: sha512-${Buffer.alloc(64,1).toString("base64")}}\n    peerDependencies: {typescript: '^5.0.0-beta.5 || >=5.0.0'}\n  '@flora/ota@file:apps/app/vendor/flora.tgz':\n    resolution: {integrity: ${integrity}, tarball: file:apps/app/vendor/flora.tgz}\nsnapshots:\n  react@19.2.3(patch_hash=${hash}): {optional: true}\n  '@flora/ota@file:apps/app/vendor/flora.tgz(react@19.2.3)': {}\n`;
 const workspace="packages:\n  - apps/*\n  - packages/*\nallowBuilds:\n  esbuild: true\npatchedDependencies:\n  react@19.2.3: patches/react.patch\n";
 await writeFile(join(source,"package.json"),JSON.stringify(root));await writeFile(join(source,"apps/app/package.json"),JSON.stringify(app));await writeFile(join(source,"packages/contracts/package.json"),JSON.stringify(contract));await writeFile(join(source,"pnpm-lock.yaml"),lock);await writeFile(join(source,"pnpm-workspace.yaml"),workspace);await writeFile(join(source,"apps/app/vendor/flora.tgz"),vendor);await writeFile(join(source,"patches/react.patch"),patch);await writeFile(join(source,"packages/contracts/src/index.ts"),"throw Error('never in online seed')");
 return{source,seed,lock,workspace,app,root};
}
test("pnpm workspace seed separates repository install root from exact app importer and excludes executable code",async t=>{
 const f=await fixture(t),{preparePnpmDependencySeed}=await api();await preparePnpmDependencySeed(f.source,"apps/app",f.seed);
 assert.deepEqual((await readdir(f.seed)).sort(),["apps","package.json","packages","patches","pnpm-lock.yaml","pnpm-workspace.yaml"]);
 assert.equal(JSON.parse(await readFile(join(f.seed,"package.json"),"utf8")).scripts,undefined);assert.equal(JSON.parse(await readFile(join(f.seed,"apps/app/package.json"),"utf8")).scripts,undefined);assert.equal(JSON.parse(await readFile(join(f.seed,"apps/app/package.json"),"utf8")).expo,undefined);
 assert.deepEqual(await readdir(join(f.seed,"packages/contracts")),["package.json"]);assert.equal((await readFile(join(f.seed,"patches/react.patch"))).toString(),"diff --git a/index.js b/index.js\n");assert.equal(await readFile(join(f.seed,"pnpm-lock.yaml"),"utf8"),f.lock);
});
for(const [name,change] of [
 ["missing explicit importer",(f:any)=>["pnpm-lock.yaml",f.lock.replace("  apps/app:","  apps/other:")]],
 ["escaping workspace link",(f:any)=>["pnpm-lock.yaml",f.lock.replace("link:../../packages/contracts","link:../../../outside")]],
 ["mutable resolved tag",(f:any)=>["pnpm-lock.yaml",f.lock.replace("react@19.2.3:","react@latest:")]],
 ["foreign tarball",(f:any)=>["pnpm-lock.yaml",f.lock.replace("resolution: {integrity: sha512-","resolution: {tarball: https://attacker.test/react.tgz, integrity: sha512-")]],
 ["lock specifier mismatch",(f:any)=>["pnpm-lock.yaml",f.lock.replace("specifier: ^19.2.3","specifier: ^18.0.0")]],
 ["unverified patch bytes",()=>["patches/react.patch","changed"]],
 ["unverified archive bytes",()=>["apps/app/vendor/flora.tgz","changed"]],
 ["snapshot reference missing verified package",(f:any)=>["pnpm-lock.yaml",f.lock.replace("react@19.2.3(patch_hash=", "react@19.2.3(patch_hash=").replace(": {optional: true}",": {optional: true, dependencies: {missing: 99.0.0}}")]],
 ["foreign URL in file peer annotation",(f:any)=>["pnpm-lock.yaml",f.lock.replaceAll("flora.tgz(react@19.2.3)","flora.tgz(react@https://attacker.test)")]],
 ["foreign URL in registry peer annotation",(f:any)=>["pnpm-lock.yaml",f.lock.replace("react@19.2.3(patch_hash=", "react@19.2.3(peer@https://attacker.test)(patch_hash=")]],
 ["pnpmfile hook",(f:any)=>["pnpm-workspace.yaml",f.workspace+"pnpmfile: ./hook.cjs\n"]],
 ["YAML alias",(f:any)=>["pnpm-lock.yaml",f.lock+"evil: &a [*a]\n"]],
] as const)test("pnpm preparation rejects "+name,async t=>{const f=await fixture(t),{preparePnpmDependencySeed}=await api(),[path,bytes]=change(f);await writeFile(join(f.source,path!),bytes!);await assert.rejects(preparePnpmDependencySeed(f.source,"apps/app",f.seed),/DEPENDENCY_CACHE_INVALID/);});
test("pnpm preparation rejects symbolic links, escaped app paths and credential config before any online container",async t=>{
 const f=await fixture(t),{preparePnpmDependencySeed}=await api();await assert.rejects(preparePnpmDependencySeed(f.source,"../outside",f.seed),/DEPENDENCY_CACHE_INVALID/);await writeFile(join(f.source,".npmrc"),"registry=https://attacker.test\n");await assert.rejects(preparePnpmDependencySeed(f.source,"apps/app",f.seed),/DEPENDENCY_CACHE_INVALID/);await rm(join(f.source,".npmrc"));await rm(join(f.source,"apps/app/vendor/flora.tgz"));await symlink("/etc/passwd",join(f.source,"apps/app/vendor/flora.tgz"));await assert.rejects(preparePnpmDependencySeed(f.source,"apps/app",f.seed),/DEPENDENCY_CACHE_INVALID/);
});
test("pnpm executor installs the sanitized root workspace and exports the admitted app offline without controller credentials",async t=>{
 const f=await fixture(t),{createDockerExecutor,encodeExport,finishExport,assetMetadata}=await import("../dist/index.js"),{chmod}=await import("node:fs/promises"),log=join(f.source,"docker-log.jsonl"),executable=join(f.source,"docker-fixture");
 const expected={platform:"android" as const,runtimeVersion:"flora-workspace",commitSha:"a".repeat(40)},encoded=encodeExport(finishExport(expected,assetMetadata("launch","bundle",Buffer.from("app-scoped output")),[]));
 await writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:a,secret:process.env.FLORA_PNPM_CANARY})+'\\n');if(a[0]==='version')process.stdout.write('test');else if(a[0]==='run'){if(a.at(-1)==='pnpm'){const seed=a.find(x=>x.includes('dst=/seed,')),root=seed.split('src=')[1].split(',')[0];const app=JSON.parse(fs.readFileSync(p.join(root,'apps/app/package.json')));if(app.scripts||fs.existsSync(p.join(root,'packages/contracts/src'))||!a.includes('--network=bridge'))process.exitCode=1;else process.stdout.write('FLORA_DEPENDENCY_CACHE_READY\\n');}else{let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const j=JSON.parse(s);if(j.rootDirectory!=='apps/app'||j.dependencyPreparation!=='pnpm-registry'||!j.offline||!j.dependencyCache||!a.includes('--network=none')||s.includes('secret'))process.exitCode=1;else process.stdout.write(${JSON.stringify(encoded)});});}}else if(a[0]!=='rm'&&a[0]!=='container')process.exitCode=1;\n`);await chmod(executable,0o755);
 const old=process.env.FLORA_PNPM_CANARY;process.env.FLORA_PNPM_CANARY="secret-not-for-container";t.after(()=>{if(old===undefined)delete process.env.FLORA_PNPM_CANARY;else process.env.FLORA_PNPM_CANARY=old;});
 const job={...expected,appId:"app_fixture",channel:"verification",rootDirectory:"apps/app",config:{runtimeVersion:expected.runtimeVersion,toolchain:{nodeVersion:"24.19.0",packageManager:{name:"pnpm",version:"11.10.0"}}}} as import("@app-ops/dogfood").AutomationJob;
 const result=await createDockerExecutor({image:"sha256:"+"a".repeat(64),resourceProfile:"github-hosted",dependencyPreparation:"pnpm-registry",executable}).execute(job,f.source,new AbortController().signal);assert.equal(result.platform,"android");assert.equal(Buffer.from(result.launchAsset.bytes).toString(),"app-scoped output");
 const calls=(await readFile(log,"utf8")).trim().split("\n").map(line=>JSON.parse(line));assert.ok(calls.every(call=>call.secret===undefined));const runs=calls.filter(call=>call.args[0]==="run");assert.equal(runs.length,2);assert.ok(runs.every(call=>!call.args.some((arg:string)=>arg.includes("docker.sock")||arg.includes("credential"))));
 await assert.rejects(createDockerExecutor({image:"sha256:"+"a".repeat(64),resourceProfile:"github-hosted",dependencyPreparation:"pnpm-registry",executable}).execute({...job,config:{...job.config,toolchain:{nodeVersion:"24.19.0",packageManager:{name:"pnpm",version:"11.11.0"}}}},f.source,new AbortController().signal),/CONFIG_CHANGED/);
});
test("pnpm workspace install is frozen and lifecycle-free in both phases; missing offline dependencies cannot request network",async t=>{
 const f=await fixture(t),{pnpmInstallRoot,pnpmInstallArguments}=await api();assert.match(await pnpmInstallRoot(f.source,"apps/app"),/\/source$/);
 for(const offline of [false,true]){const args=pnpmInstallArguments(offline);for(const flag of ["--frozen-lockfile","--ignore-scripts","--ignore-pnpmfile","--no-runtime","--config.manage-package-manager-versions=false","--config.verify-store-integrity=true","--config.cache-dir=/workspace/cache/pnpm/metadata-cache","--reporter=append-only"])assert.ok(args.includes(flag),flag);assert.ok(args.includes(offline?"--package-import-method=hardlink":"--package-import-method=copy"));assert.equal(args.includes("--offline"),offline);assert.equal(args.includes("--config.fetch-retries=0"),offline);}
 await assert.rejects(pnpmInstallRoot(f.source,"packages/not-registered"));
});
test("PNPM cache drops only its exact temporary project registration and keeps verified package files",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"flora-pnpm-cache-"));t.after(()=>rm(directory,{recursive:true,force:true}));const cache=join(directory,"workspace/cache/pnpm"),seed=join(directory,"workspace/seed"),link=join(cache,"v11/projects", "a".repeat(32));await mkdir(join(cache,"v11/projects"),{recursive:true});await mkdir(join(cache,"v11/files"));await mkdir(seed,{recursive:true});await writeFile(join(cache,"v11/files/content"),"verified bytes");await symlink("../../../../seed",link);
 const {preparePnpmCacheForTransfer}=await api();await preparePnpmCacheForTransfer(cache,seed);assert.deepEqual(await readdir(join(cache,"v11/projects")),[]);assert.equal(await readFile(join(cache,"v11/files/content"),"utf8"),"verified bytes");
});
for(const [location,target]of [["v11/files/content","../../../../seed"],["v11/projects/"+"b".repeat(32),"/etc/passwd"],["v11/projects/"+"c".repeat(32),"../../../../other"],["v11/projects/not-a-registration","../../../../seed"]])test("PNPM cache refuses non-registration or altered symlinks "+location,async t=>{
 const directory=await mkdtemp(join(tmpdir(),"flora-pnpm-cache-bad-"));t.after(()=>rm(directory,{recursive:true,force:true}));const cache=join(directory,"workspace/cache/pnpm"),seed=join(directory,"workspace/seed");await mkdir(join(cache,"v11/files"),{recursive:true});await mkdir(join(cache,"v11/projects"));await mkdir(seed,{recursive:true});await symlink(target!,join(cache,location!));const {preparePnpmCacheForTransfer}=await api();await assert.rejects(preparePnpmCacheForTransfer(cache,seed),/DEPENDENCY_CACHE_INVALID/);
});
test("offline package hardlinks cannot mutate the original transferred cache",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"flora-pnpm-hardlink-boundary-"));t.after(()=>rm(directory,{recursive:true,force:true}));const original=join(directory,"transferred-cache"),compiler=join(directory,"compiler/cache"),installed=join(directory,"compiler/package.js");await mkdir(join(original,"v11/files"),{recursive:true});await writeFile(join(original,"v11/files/content"),"immutable transferred package");
 const {copyPnpmCacheForCompilation}=await api();await copyPnpmCacheForCompilation(original,compiler);const {link,lstat}=await import("node:fs/promises");await link(join(compiler,"v11/files/content"),installed);await writeFile(installed,"changed by repository export code");assert.equal(await readFile(join(original,"v11/files/content"),"utf8"),"immutable transferred package");assert.equal((await lstat(join(original,"v11/files/content"))).nlink,1);assert.equal((await lstat(join(compiler,"v11/files/content"))).nlink,2);
});
