import { createHash } from "node:crypto";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { invariant, readBoundedFile, relativePath } from "./artifacts.js";

export const NPM_REGISTRY="https://registry.npmjs.org";
export const HOSTED_NODE_VERSION="24.19.0", HOSTED_NPM_VERSION="10.9.8";
function object(input:unknown):Record<string,unknown>{invariant(input&&typeof input==="object"&&!Array.isArray(input));return input as Record<string,unknown>;}
function vendorPath(resolved:string):string{
 invariant(/^file:vendor\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.tgz$/.test(resolved));return relativePath(resolved.slice(5));
}
function specification(input:unknown){
 invariant(typeof input==="string"&&input.length>0&&input.length<=256);
 if(input.startsWith("file:")){vendorPath(input);return;}
 // Registry tags, semver ranges and override references only. Git shorthands,
 // arbitrary URLs, workspace/link protocols and npm aliases are deliberately unsupported.
 invariant(/^[A-Za-z0-9$._*+^~|<>= -]+$/.test(input));
}
function dependencies(input:unknown){for(const [name,value] of Object.entries(object(input))){invariant(/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name)&&![".",".."].includes(name));specification(value);}}
function overrides(input:unknown,depth=0){invariant(depth<=8);for(const [name,value] of Object.entries(object(input))){invariant(name.length<=256&&!/[\u0000-\u001f]/.test(name));if(typeof value==="string")specification(value);else overrides(value,depth+1);}}
function integrity(input:unknown):string{
 invariant(typeof input==="string"&&/^sha512-[A-Za-z0-9+/]{86}==$/.test(input));const value=input.slice(7);invariant(Buffer.from(value,"base64").length===64&&Buffer.from(value,"base64").toString("base64")===value);return input;
}
function registryTarball(resolved:string){
 const url=new URL(resolved);invariant(url.origin===NPM_REGISTRY&&url.protocol==="https:"&&!url.username&&!url.password&&!url.search&&!url.hash&&resolved===url.href);
 invariant(/^\/(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+\/-\/[A-Za-z0-9._-]+\.tgz$/.test(url.pathname));
}

/** Read-only analysis of verified source. It never evaluates repository code or extracts archives. */
export async function prepareNpmDependencySeed(source:string,rootDirectory:string,destination:string):Promise<void>{
 try{
  const base=await realpath(source),root=await realpath(join(base,rootDirectory==="."?"":relativePath(rootDirectory)));invariant(root===base||root.startsWith(base+sep));
  const packageBytes=await readBoundedFile(root,"package.json",131072),lockBytes=await readBoundedFile(root,"package-lock.json",8*1024*1024);
  const pkg=object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(packageBytes))),lock=object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(lockBytes)));
  invariant(lock.lockfileVersion===3&&pkg.workspaces===undefined&&typeof pkg.name==="string"&&typeof pkg.version==="string");
  const clean:Record<string,unknown>={name:pkg.name,version:pkg.version,private:true};
  for(const field of ["dependencies","devDependencies","optionalDependencies","peerDependencies"]){if(pkg[field]!==undefined){dependencies(pkg[field]);clean[field]=pkg[field];}}
  if(pkg.peerDependenciesMeta!==undefined)clean.peerDependenciesMeta=object(pkg.peerDependenciesMeta);
  if(pkg.overrides!==undefined){overrides(pkg.overrides);clean.overrides=pkg.overrides;}
  const packages=object(lock.packages),entries=Object.entries(packages);invariant(entries.length>1&&entries.length<=2000&&packages[""]!==undefined);
  const vendors=new Map<string,{bytes:Uint8Array;integrity:string}>();let total=0;
  for(const [path,input] of entries){
   invariant(path.length<=2048&&!/[\\\u0000-\u001f]/.test(path)&&path.split("/").every(part=>part!=="."&&part!=="..")&&(path===""||path.startsWith("node_modules/")));
   const entry=object(input);invariant(entry.link!==true);
   for(const field of ["dependencies","optionalDependencies","peerDependencies"]){if(entry[field]!==undefined)dependencies(entry[field]);}
   if(path==="")continue;
   invariant(typeof entry.resolved==="string");const expected=integrity(entry.integrity);
   if(entry.resolved.startsWith("file:")){
    const vendor=vendorPath(entry.resolved),existing=vendors.get(vendor);if(existing){invariant(existing.integrity===expected);continue;}
    const bytes=await readBoundedFile(root,vendor,16*1024*1024);invariant("sha512-"+createHash("sha512").update(bytes).digest("base64")===expected);total+=bytes.length;invariant(total<=64*1024*1024);vendors.set(vendor,{bytes,integrity:expected});
   }else registryTarball(entry.resolved);
  }
  // Only these files cross into the online, script-disabled npm preparation container.
  await mkdir(destination,{mode:0o700});await writeFile(join(destination,"package.json"),JSON.stringify(clean),{mode:0o444});await writeFile(join(destination,"package-lock.json"),lockBytes,{mode:0o444});
  for(const [path,{bytes}] of vendors){await mkdir(dirname(join(destination,path)),{recursive:true,mode:0o700});await writeFile(join(destination,path),bytes,{mode:0o444});}
 }catch{throw new Error("DEPENDENCY_CACHE_INVALID");}
}
