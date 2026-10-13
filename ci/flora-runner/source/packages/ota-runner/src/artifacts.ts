import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
export const MAX_ASSET_BYTES = 16 * 1024 * 1024, MAX_EXPORT_BYTES = 64 * 1024 * 1024, MAX_ASSETS = 64;
// Expo replaces its output directory before export. It must never be a mount root.
export const CONTAINER_EXPORT_DIRECTORY="/output/export";
export interface ExportExpectation { platform: "ios" | "android"; runtimeVersion: string; commitSha: string }
export interface ExportAsset { key: string; contentType: string; fileExtension: string; digest: string; bytes: Uint8Array }
export interface ExportBundle extends ExportExpectation { launchAsset: ExportAsset; assets: ExportAsset[]; artifactDigest: string }
export function invariant(value: unknown, code = "ARTIFACT_INVALID"): asserts value { if (!value) throw new Error(code); }
export const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export function relativePath(value: unknown): string {
 invariant(typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\\:\u0000-\u001f\u007f]/.test(value));
 invariant(value.split("/").every(part => part && part !== "." && part !== ".." && ![".git","node_modules"].includes(part)));
 return value;
}
export async function readBoundedFile(root: string, input: string, limit: number): Promise<Uint8Array> {
 const path = relativePath(input), boundary = await realpath(root); let cursor = boundary;
 for (const part of path.split("/")) { cursor = join(cursor,part); const stat = await lstat(cursor); invariant(!stat.isSymbolicLink()); }
 const actual = await realpath(cursor); invariant(actual.startsWith(boundary + sep));
 const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
 try { const stat = await file.stat(); invariant(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= limit); const bytes = await file.readFile(); invariant(bytes.length === stat.size && bytes.length <= limit); return bytes; }
 finally { await file.close(); }
}
// Android vector drawables are opaque verified bytes here, not parsed XML.
const types: Record<string,string> = { js:"application/javascript",bundle:"application/javascript",hbc:"application/octet-stream",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",gif:"image/gif",webp:"image/webp",avif:"image/avif",ttf:"font/ttf",otf:"font/otf",woff:"font/woff",woff2:"font/woff2",mp3:"audio/mpeg",wav:"audio/wav",ogg:"audio/ogg",mp4:"video/mp4",json:"application/json",xml:"application/octet-stream",wasm:"application/wasm" };
export function assetMetadata(key: unknown, extension: unknown, bytes: Uint8Array): ExportAsset {
 invariant(typeof key === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(key));
 invariant(typeof extension === "string" && /^\.?[A-Za-z0-9]{1,15}$/.test(extension));
 const ext = extension.replace(/^\./,"").toLowerCase(), contentType = types[ext]; invariant(Object.hasOwn(types,ext) && typeof contentType === "string" && bytes.length > 0 && bytes.length <= MAX_ASSET_BYTES);
 return { key,contentType,fileExtension:"."+ext,digest:sha256(bytes),bytes:bytes.slice() };
}
export function finishExport(expectation: ExportExpectation, launchAsset: ExportAsset, assets: ExportAsset[]): ExportBundle {
 invariant(["ios","android"].includes(expectation.platform) && /^[a-f0-9]{40}$/.test(expectation.commitSha) && typeof expectation.runtimeVersion === "string" && expectation.runtimeVersion.length > 0 && expectation.runtimeVersion.length <= 128);
 invariant(assets.length <= MAX_ASSETS && new Set([launchAsset.key,...assets.map(a=>a.key)]).size === assets.length+1);
 invariant([launchAsset,...assets].reduce((sum,a)=>sum+a.bytes.length,0) <= MAX_EXPORT_BYTES);
 const facts = { ...expectation, launchAsset: {key:launchAsset.key,digest:launchAsset.digest},assets:assets.map(a=>({key:a.key,digest:a.digest})) };
 return {...expectation,launchAsset,assets,artifactDigest:sha256(JSON.stringify(facts))};
}
/** Reads real Expo CLI v0 export metadata; our Metro adapter emits the same file/asset shape. */
export async function readExport(directory: string, expectation: ExportExpectation): Promise<ExportBundle> {
 try {
  const raw = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await readBoundedFile(resolve(directory),"metadata.json",131072))) as Record<string,unknown>;
  invariant(raw.version === 0 && raw.bundler === "metro" && raw.fileMetadata && typeof raw.fileMetadata === "object");
  const metadata = (raw.fileMetadata as Record<string,unknown>)[expectation.platform] as {bundle?:unknown;assets?:unknown}; invariant(metadata && typeof metadata === "object" && Array.isArray(metadata.assets) && metadata.assets.length <= MAX_ASSETS);
  const bundle = relativePath(metadata.bundle), launch = await readBoundedFile(directory,bundle,MAX_ASSET_BYTES);
  const launchAsset = assetMetadata(sha256(launch), extname(bundle).slice(1) || "bundle",launch);
  const assets: ExportAsset[] = [];
  for (const input of metadata.assets) {
   invariant(input && typeof input === "object" && !Array.isArray(input)); const value = input as Record<string,unknown>, path = relativePath(value.path);
   assets.push(assetMetadata(value.key ?? basename(path),value.ext,await readBoundedFile(directory,path,MAX_ASSET_BYTES)));
  }
  return finishExport(expectation,launchAsset,assets);
 } catch { throw new Error("ARTIFACT_INVALID"); }
}
export function encodeExport(bundle: ExportBundle): string {
 const encode = (a:ExportAsset)=>({...a,bytes:Buffer.from(a.bytes).toString("base64")}); return JSON.stringify({...bundle,launchAsset:encode(bundle.launchAsset),assets:bundle.assets.map(encode)});
}
export function decodeExport(text: string, expectation: ExportExpectation): ExportBundle {
 try {
  invariant(Buffer.byteLength(text)<=96*1024*1024); const value=JSON.parse(text) as ExportBundle;
  invariant(value.commitSha===expectation.commitSha && value.platform===expectation.platform && value.runtimeVersion===expectation.runtimeVersion && Array.isArray(value.assets));
  const decode=(input:ExportAsset)=>{invariant(typeof input.bytes==="string" && /^[A-Za-z0-9+/]*={0,2}$/.test(input.bytes)); const bytes=Buffer.from(input.bytes,"base64"); invariant(bytes.toString("base64")===input.bytes); const a=assetMetadata(input.key,input.fileExtension,bytes); invariant(a.digest===input.digest && a.contentType===input.contentType);return a;};
  const bundle=finishExport(expectation,decode(value.launchAsset),value.assets.map(decode)); invariant(bundle.artifactDigest===value.artifactDigest);return bundle;
 }catch{throw new Error("ARTIFACT_INVALID");}
}
