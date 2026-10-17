import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createFloraAssetResolver, FloraAssetError } from "../dist/asset-resolver.js";

const updateId = "11111111-1111-4111-8111-111111111111", scope = "a".repeat(64);
const config = { enabled: true, appId: "app_native", url: "https://flora.example/updates/app_native", channel: "flora-validation", runtimeVersion: "native-1", platform: "ios" };
const key1 = "1".repeat(32), key2 = "2".repeat(32), fontKey = "3".repeat(32);
const prefix = `file:///private/Library/Application%20Support/FloraOTA/app_native/${scope}/${updateId}/`;
const image1 = prefix + "1".repeat(64) + ".png", image2 = prefix + "2".repeat(64) + ".png", font = prefix + "3".repeat(64) + ".ttf";
const launch = { appId: config.appId, runtimeVersion: config.runtimeVersion, source: "update", updateId, assets: { [key1]: image1, [key2]: image2, [fontKey]: font } };
const hasCode = (code: string) => (error: unknown) => error instanceof FloraAssetError && error.code === code;

test("verified asset resolver chooses the correct Expo file hash for device scale", () => {
  let scale = 1;
  const resolver = createFloraAssetResolver(config, launch, () => scale)!;
  const metadata = { scales: [1, 2], fileHashes: [key1, key2], hash: "4".repeat(32) };
  assert.equal(resolver.resolveMetadata(metadata), image1);
  scale = 1.5; assert.equal(resolver.resolveMetadata(metadata), image2);
  scale = 3; assert.equal(resolver.resolveMetadata(metadata), image2);
  assert.deepEqual(resolver.transform({ asset: metadata, fromSource: uri => ({ uri, scale }) }), { uri: image2, scale: 3 });
  assert.equal(resolver.resolveMetadata({ scales: [1], hash: fontKey }), font);
  const source = { ...launch, assets: { ...launch.assets } }, copied = createFloraAssetResolver(config, source, () => 1)!;
  source.assets[key1] = "file:///foreign.png";
  assert.equal(copied.resolveMetadata({ scales: [1], fileHashes: [key1] }), image1);
});

test("asset resolver preserves embedded startup without touching asset resolution", () => {
  assert.equal(createFloraAssetResolver(config, { ...launch, source: "embedded", updateId: null, assets: {} }, () => 1), undefined);
  assert.throws(() => createFloraAssetResolver(config, { ...launch, source: "embedded", updateId: null }, () => 1), hasCode("NATIVE_ASSET_CONFIGURATION_INVALID"));
});

test("asset resolver admits 46 and 64 signed-map files, rejecting 65", () => {
  function assets(count: number) { return Object.fromEntries(Array.from({ length: count }, (_, index) => [index.toString(16).padStart(32, "0"), prefix + index.toString(16).padStart(64, "0") + ".png"])); }
  for (const count of [46, 64]) assert.equal(Object.keys(createFloraAssetResolver(config, { ...launch, assets: assets(count) }, () => 1)!.launch.assets).length, count);
  assert.throws(() => createFloraAssetResolver(config, { ...launch, assets: assets(65) }, () => 1), hasCode("NATIVE_ASSET_CONFIGURATION_INVALID"));
});

test("asset resolver refuses foreign binding, launch directories, network paths and aliasing", () => {
  for (const value of [
    { ...launch, appId: "app_foreign" }, { ...launch, runtimeVersion: "foreign" },
    { ...launch, assets: { [key1]: "https://flora.example/image.png" } },
    { ...launch, assets: { [key1]: image1.replace(updateId, "22222222-2222-4222-8222-222222222222") } },
    { ...launch, assets: { [key1]: image1.replace("app_native", "app_foreign") } },
    { ...launch, assets: { [key1]: image1 + "?uri=foreign" } }, { ...launch, assets: { [key1]: image1 + "#local" } },
    { ...launch, assets: { [key1]: image1, [key2]: image1 } },
  ]) assert.throws(() => createFloraAssetResolver(config, value, () => 1), hasCode("NATIVE_ASSET_CONFIGURATION_INVALID"));
  const android = { ...config, platform: "android" };
  const androidUri = `file:///data/user/0/kr.co.uulab.isso/no_backup/flora-ota/${scope}/updates/${updateId}/${"1".repeat(64)}.bin`;
  assert.equal(createFloraAssetResolver(android, { ...launch, assets: { [key1]: androidUri } }, () => 1)!.resolveMetadata({ scales: [1], fileHashes: [key1] }), androidUri);
  assert.throws(() => createFloraAssetResolver(android, launch, () => 1), hasCode("NATIVE_ASSET_CONFIGURATION_INVALID"));
});

test("asset resolver fails closed for unknown scale hashes and ambiguous metadata", () => {
  const resolver = createFloraAssetResolver(config, launch, () => 2)!;
  assert.throws(() => resolver.resolveMetadata({ scales: [1, 2], fileHashes: [key1, "f".repeat(32)], hash: key1 }), hasCode("ASSET_NOT_IN_MANIFEST"));
  for (const metadata of [
    { scales: [], fileHashes: [] }, { scales: [2, 1], fileHashes: [key1, key2] }, { scales: [1, 1], fileHashes: [key1, key2] },
    { scales: [1, 2], fileHashes: [key1] }, { scales: [1, 2], fileHashes: [key1, key1] },
    { scales: [1, 2], hash: key1 }, { scales: [0], fileHashes: [key1] }, { scales: [1], fileHashes: ["../asset"] },
  ]) assert.throws(() => resolver.resolveMetadata(metadata), hasCode("ASSET_METADATA_INVALID"));
});

test("native synchronous installer resolves require images and Expo font assets before router startup", async t => {
  const directory = await mkdtemp(join(tmpdir(), "flora-native-asset-consumer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "native")); await mkdir(join(directory, "dist")); await mkdir(join(directory, "node_modules/react-native"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await writeFile(join(directory, "node_modules/react-native/package.json"), JSON.stringify({ name: "react-native", version: "0.86.3", type: "module", main: "index.js" }));
  await copyFile(new URL("../native/index.js", import.meta.url), join(directory, "native/index.js"));
  for (const file of ["index.js", "native-adapter.js", "asset-resolver.js", "telemetry.js"]) await copyFile(new URL("../dist/" + file, import.meta.url), join(directory, "dist", file));
  await writeFile(join(directory, "node_modules/react-native/index.js"), `
    export const NativeModules={FloraOta:{initialConfiguration:${JSON.stringify(config)},initialLaunchInfo:${JSON.stringify(launch)}}};
    export const registry={1:{name:'image',type:'png',width:24,height:24,scales:[1,2],fileHashes:${JSON.stringify([key1, key2])}},2:{name:'ProductFont',type:'ttf',scales:[1],fileHashes:${JSON.stringify([fontKey])}},3:{name:'foreign',type:'png',scales:[1],fileHashes:['ffffffffffffffffffffffffffffffff']}};
    export const PixelRatio={get:()=>2};
    let transformer;
    export const Image={resolveAssetSource(id){const asset=registry[id];if(!asset)return null;return transformer?transformer({asset,fromSource:uri=>({uri,width:asset.width,height:asset.height})}):{uri:'file:///wrong-native-default/'+asset.name};}};
    Image.resolveAssetSource.setCustomSourceTransformer=value=>{transformer=value;};
    export class Asset {
      constructor(uri){this.uri=uri;this.localUri=null;this.downloaded=false;}
      static fromModule(value){return new Asset(typeof value==='number'?'file:///wrong-expo-default/'+registry[value].name:value.uri);}
      static fromMetadata(meta){return new Asset('file:///wrong-metadata-default/'+meta.name);}
      async downloadAsync(){if(!this.downloaded||this.localUri!==this.uri)throw new Error('Unverified font/image download');return this;}
    }
  `);
  await writeFile(join(directory, "verify.mjs"), `
    import assert from 'node:assert/strict';
    import {installFloraAssetResolver} from './native/index.js';
    import {Image,Asset,registry,NativeModules} from 'react-native';
    if(process.argv.includes('--embedded')){
      NativeModules.FloraOta.initialLaunchInfo={appId:'app_native',runtimeVersion:'native-1',source:'embedded',updateId:null,assets:{}};
      const original=Asset.fromModule;
      assert.deepEqual(installFloraAssetResolver({expoAsset:Asset}),{source:'embedded',updateId:null,assetCount:0});
      assert.equal(Asset.fromModule,original);
      assert.equal(Image.resolveAssetSource(1).uri,'file:///wrong-native-default/image');
      process.exit(0);
    }
    const installed=installFloraAssetResolver({expoAsset:Asset});
    assert.deepEqual(installed,{source:'update',updateId:${JSON.stringify(updateId)},assetCount:3});
    assert.equal(Image.resolveAssetSource(1).uri,${JSON.stringify(image2)});
    const loadedImage=await Asset.fromModule(1).downloadAsync();assert.equal(loadedImage.localUri,${JSON.stringify(image2)});
    const loadedFont=await Asset.fromModule(2).downloadAsync();assert.equal(loadedFont.localUri,${JSON.stringify(font)});
    assert.equal((await Asset.fromMetadata(registry[2]).downloadAsync()).uri,${JSON.stringify(font)});
    assert.throws(()=>Asset.fromModule(3),/ASSET_NOT_IN_MANIFEST/);
    assert.equal(Asset.fromModule({uri:'https://product.example/remote.png'}).uri,'https://product.example/remote.png');
    // Embedded startup does not replace either existing transformer or Expo methods.
    NativeModules.FloraOta.initialLaunchInfo={appId:'app_native',runtimeVersion:'native-1',source:'embedded',updateId:null,assets:{}};
    const prior=Asset.fromModule;
    assert.deepEqual(installFloraAssetResolver({expoAsset:Asset}),{source:'embedded',updateId:null,assetCount:0});
    assert.equal(Asset.fromModule,prior);
  `);
  const result = spawnSync(process.execPath, ["verify.mjs"], { cwd: directory, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const embedded = spawnSync(process.execPath, ["verify.mjs", "--embedded"], { cwd: directory, encoding: "utf8", timeout: 10000 });
  assert.equal(embedded.status, 0, embedded.stderr);
});
