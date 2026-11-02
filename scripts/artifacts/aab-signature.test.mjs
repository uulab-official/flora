import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshotLocalRecipe } from './build-recipe.mjs';
import { signedBundleFixture,zipFixture,readFixtureEntries } from './signature-fixture.mjs';
const {verifyAabSignature} = await import('./verify-aab-signature.mjs').catch(()=>({}));
let f;before(async()=>{f=await signedBundleFixture();});after(async()=>{await f?.close();});
const verify=async(path=f.signed,policy=f.policy,extra={})=>{assert.equal(typeof verifyAabSignature,'function','AAB verification must be implemented');return verifyAabSignature({directory:f.root,filePath:path,manifest:await f.manifest(path),expected:f.context,policy,...extra});};
test('real JDK signature is verified against pinned certificate without asserting bundle validity or install',async()=>{
 const e=await verify();assert.equal(e.scheme,'aab-jar-v1');assert.equal(e.signerSha256,f.policy.expectedSignerSha256);assert.equal(e.sha256,(await f.manifest()).sha256);assert.equal(e.signedEntries,3);assert.equal(e.bundleValidated,false);assert.equal(e.installVerified,false);assert.equal((await readdir(f.root)).some(n=>n.startsWith('.signature-')),false);
});
test('valid bytes with wrong pinned certificate are rejected',async()=>{await assert.rejects(verify(f.signed,{...f.policy,expectedSignerSha256:'0'.repeat(64)}),/ARTIFACT_SIGNATURE_SIGNER_MISMATCH/);});
test('unsigned container is rejected instead of using a hash as signing proof',async()=>{await assert.rejects(verify(f.unsigned),/ARTIFACT_SIGNATURE_UNSIGNED/);});
for(const name of ['base/assets/added.txt','META-INF/added.txt'])test('unsigned extra payload rejected: '+name,async()=>{
 const p=join(f.root,'extra-'+name.replaceAll('/','_')+'.aab');await writeFile(p,zipFixture([...readFixtureEntries(await readFile(f.signed)),[name,'unsigned extra']]));await assert.rejects(verify(p),/ARTIFACT_SIGNATURE_UNSIGNED/);
});
test('tampered signed payload is cryptographically rejected even with a correct new byte hash',async()=>{
 const p=join(f.root,'tampered.aab'),entries=readFixtureEntries(await readFile(f.signed)).map(([n,b])=>[n,n==='base/dex/classes.dex'?Buffer.alloc(b.length,65):b]);await writeFile(p,zipFixture(entries));await assert.rejects(verify(p),/ARTIFACT_SIGNATURE_INVALID/);
});
for(const name of ['../escape','/absolute','base\\escape','base/./escape'])test('unsafe archive name is rejected: '+name,async()=>{
 const p=join(f.root,'unsafe-'+Buffer.from(name).toString('hex')+'.aab');await writeFile(p,zipFixture([...f.entries,[name,'bad']]));await assert.rejects(verify(p),/ARTIFACT_SIGNATURE_LAYOUT_INVALID/);
});
test('duplicate entries are rejected',async()=>{const p=join(f.root,'duplicate.aab');await writeFile(p,zipFixture([...f.entries,f.entries[0]]));await assert.rejects(verify(p),/ARTIFACT_SIGNATURE_LAYOUT_INVALID/);});
test('plain signed jar is not presented as a verified bundle',async()=>{const p=join(f.root,'notbundle.aab');await writeFile(p,zipFixture(readFixtureEntries(await readFile(f.signed)).filter(([n])=>n!=='BundleConfig.pb')));await assert.rejects(verify(p),/ARTIFACT_SIGNATURE_LAYOUT_INVALID/);});
test('expired signing certificate fails even when its fingerprint is pinned',async()=>{const expired=await signedBundleFixture({expired:true});try{await assert.rejects(verify(expired.signed,expired.policy,{expected:expired.context,manifest:await expired.manifest()}),/ARTIFACT_SIGNATURE_CERTIFICATE_INVALID/);}finally{await expired.close();}});
test('invalid signature policy and cross-scope arguments fail before tool invocation',async()=>{
 await assert.rejects(verify(f.signed,{...f.policy,expectedSignerSha256:f.policy.expectedSignerSha256+'\n'}),/ARTIFACT_SIGNATURE_POLICY_INVALID/);
 await assert.rejects(verify(f.signed,{...f.policy,unknown:true}),/ARTIFACT_SIGNATURE_POLICY_INVALID/);
 await assert.rejects(verify(f.signed,f.policy,{expected:{...f.context,jobId:'another'}}),/ARTIFACT_SCOPE_MISMATCH/);
});
test('aborted and time-limited verification clean up staging and never return evidence',async()=>{
 const c=new AbortController();c.abort();await assert.rejects(verify(f.signed,f.policy,{signal:c.signal}),/BUILD_PROCESS_ABORTED/);
 const slow=join(f.root,'slow-java');await writeFile(slow,'#!/bin/sh\nsleep 10\n');await chmod(slow,0o700);
 await assert.rejects(verify(f.signed,{...f.policy,javaExecutable:slow,timeoutMs:100}),/ARTIFACT_SIGNATURE_TIMEOUT/);
 assert.equal((await readdir(f.root)).some(n=>n.startsWith('.signature-')),false);
});
test('AAB signing policy is explicitly opt-in and rejected for APK or IPA recipes',()=>{
 const recipe={...f.context,cwd:f.root,executable:process.execPath,args:[],artifactPath:f.signed,format:'aab'};delete recipe.jobId;delete recipe.sourceSha;
 const signed=snapshotLocalRecipe({...recipe,signaturePolicy:f.policy});assert.equal(signed.signaturePolicy.scheme,'aab-jar-v1');assert.ok(Object.isFrozen(signed.signaturePolicy));
 assert.throws(()=>snapshotLocalRecipe({...recipe,format:'apk',artifactPath:join(f.root,'x.apk'),signaturePolicy:f.policy}),/ARTIFACT_SIGNATURE_POLICY_INVALID/);
 assert.throws(()=>snapshotLocalRecipe({...recipe,platform:'ios',format:'ipa',artifactPath:join(f.root,'x.ipa'),signaturePolicy:f.policy}),/ARTIFACT_SIGNATURE_POLICY_INVALID/);
 assert.equal(snapshotLocalRecipe(recipe).signaturePolicy,undefined);
});
test('removing a signed payload entry is detected rather than silently accepting a subset',async()=>{
 const p=join(f.root,'deleted.aab');await writeFile(p,zipFixture(readFixtureEntries(await readFile(f.signed)).filter(([n])=>n!=='base/dex/classes.dex')));await assert.rejects(verify(p),/ARTIFACT_SIGNATURE_LAYOUT_INVALID/);
});
test('orphan signature metadata is not exempted as arbitrary unsigned payload',async()=>{
 const p=join(f.root,'orphan.aab');await writeFile(p,zipFixture([...readFixtureEntries(await readFile(f.signed)),['META-INF/ORPHAN.RSA','not a signature']]));await assert.rejects(verify(p),/ARTIFACT_SIGNATURE_LAYOUT_INVALID/);
});
test('signature policy and manifest are snapshotted before asynchronous IO',async()=>{
 const policy={...f.policy},manifest=await f.manifest();const task=verifyAabSignature({directory:f.root,filePath:f.signed,manifest,expected:f.context,policy});policy.expectedSignerSha256='e'.repeat(64);manifest.sha256='d'.repeat(64);const e=await task;assert.equal(e.signerSha256,f.policy.expectedSignerSha256);assert.equal(e.sha256,(await f.manifest()).sha256);
});
test('helper errors do not disclose raw output or credentials',async()=>{
 const tool=join(f.root,'bad-java');await writeFile(tool,'#!/bin/sh\nprintf \'private-token-do-not-persist\' >&2\nexit 1\n');await chmod(tool,0o700);await assert.rejects(verify(f.signed,{...f.policy,javaExecutable:tool}),e=>e.message==='ARTIFACT_SIGNATURE_TOOL_FAILED');
});
test('oversized signing metadata is rejected before manifest parsing',async()=>{
 const p=join(f.root,'large-meta.aab');await writeFile(p,zipFixture([...f.entries,['META-INF/MANIFEST.MF',Buffer.alloc(8*1024*1024+1,65)]]));await assert.rejects(verify(p),/ARTIFACT_SIGNATURE_LIMIT/);
});
