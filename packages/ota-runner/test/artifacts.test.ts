import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import * as module from "../dist/index.js";
const api = module as unknown as { readExport(path: string, expectation: { platform: "ios"; runtimeVersion: string; commitSha: string }): Promise<{launchAsset: { key: string; digest: string; bytes: Uint8Array }; assets: { key: string; digest: string; bytes: Uint8Array }[]}> };
const expectation = { platform: "ios" as const, runtimeVersion: "native-1", commitSha: "a".repeat(40) };
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "flora-artifacts-")); t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(join(root,"assets")); await writeFile(join(root,"launch.js"),"globalThis.one=1;"); await writeFile(join(root,"assets","bundler-key"),"image-bytes");
  await writeFile(join(root,"metadata.json"),JSON.stringify({version:0,bundler:"metro",fileMetadata:{ios:{bundle:"launch.js",assets:[{path:"assets/bundler-key",ext:"png"}]}}}));
  return root;
}
test("actual exporter metadata preserves its asset key and hashes the emitted file bytes",async t=>{
 const root=await fixture(t), exported=await api.readExport(root,expectation);
 assert.equal(exported.assets[0]!.key,"bundler-key"); assert.equal(exported.assets[0]!.digest,createHash("sha256").update("image-bytes").digest("hex"));
 assert.equal(new TextDecoder().decode(exported.launchAsset.bytes),"globalThis.one=1;");
});
test("exported symlinks cannot read files outside the output boundary",async t=>{
 const root=await fixture(t); await rm(join(root,"assets","bundler-key")); await symlink("/etc/passwd",join(root,"assets","bundler-key"));
 await assert.rejects(api.readExport(root,expectation), (error:unknown)=>error instanceof Error && error.message==="ARTIFACT_INVALID");
});
test("traversal in real exporter metadata is rejected before any asset is read",async t=>{
 const root=await fixture(t); await writeFile(join(root,"metadata.json"),JSON.stringify({version:0,bundler:"metro",fileMetadata:{ios:{bundle:"../outside.js",assets:[]}}}));
 await assert.rejects(api.readExport(root,expectation),(error:unknown)=>error instanceof Error && error.message==="ARTIFACT_INVALID");
});
test("prototype property names cannot become asset MIME types",async t=>{
 const root=await fixture(t);await writeFile(join(root,"metadata.json"),JSON.stringify({version:0,bundler:"metro",fileMetadata:{ios:{bundle:"launch.js",assets:[{path:"assets/bundler-key",ext:"constructor"}]}}}));
 await assert.rejects(api.readExport(root,expectation),(error:unknown)=>error instanceof Error&&error.message==="ARTIFACT_INVALID");
});

test("real exporter metadata keeps all 46 assets required by a current Expo app", async t => {
  const root = await fixture(t), assets = [];
  for (let i = 0; i < 46; i++) {
    const path = `assets/image-${i}`;
    await writeFile(join(root, path), `distinct-image-bytes-${i}`);
    assets.push({ path, ext: "png" });
  }
  await writeFile(join(root, "metadata.json"), JSON.stringify({ version: 0, bundler: "metro", fileMetadata: { ios: { bundle: "launch.js", assets } } }));
  const exported = await api.readExport(root, expectation);
  assert.equal(exported.assets.length, 46);
  assert.equal(new Set(exported.assets.map(asset => asset.key)).size, 46);
  for (let i = 0; i < 46; i++) {
    assert.equal(exported.assets[i]!.key, `image-${i}`);
    assert.equal(new TextDecoder().decode(exported.assets[i]!.bytes), `distinct-image-bytes-${i}`);
  }
});

test("exporter metadata exceeding the bounded 64-asset budget is rejected", async t => {
  const root = await fixture(t), assets = [];
  for (let i = 0; i < 65; i++) {
    const path = `assets/image-${i}`;
    await writeFile(join(root, path), `distinct-image-bytes-${i}`);
    assets.push({ path, ext: "png" });
  }
  await writeFile(join(root, "metadata.json"), JSON.stringify({ version: 0, bundler: "metro", fileMetadata: { ios: { bundle: "launch.js", assets } } }));
  await assert.rejects(api.readExport(root, expectation), /ARTIFACT_INVALID/);
});
test("Expo Android vector drawable XML metadata preserves original keys bytes and SHA256 digests",async t=>{
 const root=await fixture(t),xml=Buffer.from('<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24"><path android:fillColor="#000000" android:pathData="M4,12L20,12"/></vector>'),key=createHash("md5").update(xml).digest("hex"),path="assets/"+key;
 await writeFile(join(root,path),xml);await writeFile(join(root,"metadata.json"),JSON.stringify({version:0,bundler:"metro",fileMetadata:{android:{bundle:"launch.js",assets:[{path,ext:"xml"}]}}}));
 const result=await module.readExport(root,{...expectation,platform:"android"});assert.equal(result.platform,"android");assert.equal(result.assets.length,1);assert.equal(result.assets[0]!.key,key);assert.equal(result.assets[0]!.contentType,"application/octet-stream");assert.equal(result.assets[0]!.fileExtension,".xml");assert.equal(result.assets[0]!.digest,createHash("sha256").update(xml).digest("hex"));assert.deepEqual(Buffer.from(result.assets[0]!.bytes),xml);
 await assert.rejects(module.readExport(root,expectation),/ARTIFACT_INVALID/);
});
test("XML asset admission retains symlink traversal and unknown-extension rejection",async t=>{
 const root=await fixture(t),path="assets/vector";await symlink("/etc/passwd",join(root,path));const metadata={version:0,bundler:"metro",fileMetadata:{android:{bundle:"launch.js",assets:[{path,ext:"xml"}]}}};await writeFile(join(root,"metadata.json"),JSON.stringify(metadata));await assert.rejects(module.readExport(root,{...expectation,platform:"android"}),/ARTIFACT_INVALID/);
 await rm(join(root,path));await writeFile(join(root,path),"<vector/>");metadata.fileMetadata.android.assets[0]!.path="../vector";await writeFile(join(root,"metadata.json"),JSON.stringify(metadata));await assert.rejects(module.readExport(root,{...expectation,platform:"android"}),/ARTIFACT_INVALID/);
 metadata.fileMetadata.android.assets[0]!.path=path;metadata.fileMetadata.android.assets[0]!.ext="html";await writeFile(join(root,"metadata.json"),JSON.stringify(metadata));await assert.rejects(module.readExport(root,{...expectation,platform:"android"}),/ARTIFACT_INVALID/);
});
