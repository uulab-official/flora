/** Bounded PNPM 11.10 workspace support. This module reads data, never repository code. */
import {createHash} from "node:crypto";
import {lstat,mkdir,writeFile,realpath,readdir,readlink,unlink,cp} from "node:fs/promises";
import {dirname,join,sep,posix} from "node:path";
import {parseDocument,stringify} from "yaml";
import {invariant,readBoundedFile,relativePath} from "./artifacts.js";
export const PC_PNPM_VERSION="11.10.0";
const groups=["dependencies","devDependencies","optionalDependencies"] as const;
const packageName=/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const exactVersion=/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;
function record(v:unknown):Record<string,unknown>{invariant(v&&typeof v==="object"&&!Array.isArray(v));return v as Record<string,unknown>;}
function string(v:unknown,max=8192):string{invariant(typeof v==="string"&&v.length>0&&v.length<=max&&!/[\\\u0000-\u001f\u007f]/.test(v));return v;}
function name(v:unknown):string{const n=string(v,214);invariant(packageName.test(n)&&n!=="."&&n!=="..");return n;}
function yaml(bytes:Uint8Array):Record<string,unknown>{const doc=parseDocument(new TextDecoder("utf-8",{fatal:true}).decode(bytes),{schema:"core",uniqueKeys:true});invariant(!doc.errors.length&&!doc.warnings.length);return record(doc.toJS({maxAliasCount:0}));}
function importerPath(v:string):string{return v==="."?v:relativePath(v);}
function vendorPath(v:unknown):string{const raw=string(v);invariant(/^file:(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*vendor\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.tgz$/.test(raw));return relativePath(raw.slice(5));}
function sri(v:unknown):string{const raw=string(v,128);invariant(/^sha512-[A-Za-z0-9+/]{86}==$/.test(raw)&&Buffer.from(raw.slice(7),"base64").toString("base64")===raw.slice(7));return raw;}
function registryTarball(v:unknown){const raw=string(v,2048),url=new URL(raw);invariant(url.origin==="https://registry.npmjs.org"&&!url.username&&!url.password&&!url.search&&!url.hash&&raw===url.href&&/^\/(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+\/-\/[A-Za-z0-9._-]+\.tgz$/.test(url.pathname));}
function reference(v:unknown):string{const raw=string(v);if(raw.startsWith("file:")){const base=raw.split("(")[0]!;vendorPath(base);invariant(/^[A-Za-z0-9@/._+()=-]*$/.test(raw.slice(base.length)));return base;}const version=raw.split("(")[0]!;invariant(exactVersion.test(version)&&/^[A-Za-z0-9@/._+()=-]+$/.test(raw));return version;}
function specification(v:unknown,n:string){const raw=string(v,256);if(raw.startsWith("workspace:")){invariant(raw==="workspace:*"||raw==="workspace:^"||raw==="workspace:~");return;}if(raw.startsWith("file:")){invariant(n==="@flora/ota");vendorPath(raw);return;}invariant(/^[A-Za-z0-9._*+^~|<>= -]+$/.test(raw)&&(raw==="*"||/\d/.test(raw))&&!/https?:|git:|npm:/.test(raw));}
async function noConfiguration(root:string){for(const file of [".npmrc",".pnpmfile.cjs",".pnpmfile.mjs","pnpmfile.cjs","pnpmfile.mjs"]){try{await lstat(join(root,file));throw Error("DEPENDENCY_CACHE_INVALID");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}}
async function roots(source:string,project:string){const base=await realpath(source),relative=importerPath(project);invariant(relative!==".");const app=await realpath(join(base,relative));invariant(app.startsWith(base+sep));return {base,project:relative,app};}
/** Repository root is the only install-root candidate; a nested workspace cannot widen source scope. */
export async function pnpmInstallRoot(source:string,project:string):Promise<string>{const {base,project:path}=await roots(source,project);const lock=yaml(await readBoundedFile(base,"pnpm-lock.yaml",8*1024*1024));invariant(lock.lockfileVersion==="9.0"&&Object.hasOwn(record(lock.importers),path),"DEPENDENCY_CACHE_INVALID");await readBoundedFile(base,"pnpm-workspace.yaml",131072);return base;}
export function pnpmInstallArguments(offline:boolean):string[]{return ["install","--frozen-lockfile","--ignore-scripts","--ignore-pnpmfile","--no-runtime","--config.manage-package-manager-versions=false","--config.verify-store-integrity=true","--config.cache-dir=/workspace/cache/pnpm/metadata-cache","--reporter=append-only",offline?"--package-import-method=hardlink":"--package-import-method=copy","--registry=https://registry.npmjs.org","--store-dir","/workspace/cache/pnpm",...(offline?["--offline","--config.fetch-retries=0"]:[])];}
export async function preparePnpmDependencySeed(source:string,project:string,destination:string):Promise<void>{
 try{
  const {base,project:projectPath}=await roots(source,project),lockBytes=await readBoundedFile(base,"pnpm-lock.yaml",8*1024*1024),lock=yaml(lockBytes),workspace=yaml(await readBoundedFile(base,"pnpm-workspace.yaml",131072));
  invariant(lock.lockfileVersion==="9.0"&&Object.keys(lock).every(k=>["lockfileVersion","settings","patchedDependencies","importers","packages","snapshots"].includes(k)));
  const settings=record(lock.settings);invariant(settings.autoInstallPeers===true&&settings.excludeLinksFromLockfile===false&&Object.keys(settings).length===2);
  invariant(Object.keys(workspace).every(k=>["packages","allowBuilds","patchedDependencies"].includes(k)));invariant(Array.isArray(workspace.packages)&&workspace.packages.length>0&&workspace.packages.length<=32);
  const patterns=workspace.packages.map(p=>{const raw=string(p,256);invariant(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\/(?:\*|[A-Za-z0-9_-][A-Za-z0-9._-]*)$/.test(raw));return raw;});
  if(workspace.allowBuilds!==undefined)for(const [n,value] of Object.entries(record(workspace.allowBuilds))){name(n);invariant(typeof value==="boolean");}
  const packages=record(lock.packages),importers=record(lock.importers),paths=Object.keys(importers);invariant(paths.includes(".")&&paths.includes(projectPath)&&paths.length<=64);
  const manifests=new Map<string,Record<string,unknown>>(),names=new Map<string,string>(),files=new Map<string,Uint8Array>();
  for(const path of paths){importerPath(path);invariant(path==="."||patterns.some(p=>p.endsWith("/*")?path.startsWith(p.slice(0,-1))&&!path.slice(p.length-1).includes("/"):p===path));const root=join(base,path==="."?"":path);await noConfiguration(root);const pkg=record(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await readBoundedFile(base,path==="."?"package.json":path+"/package.json",131072))));
   const n=name(pkg.name);invariant(typeof pkg.version==="string"&&exactVersion.test(pkg.version)&&!names.has(n));names.set(n,path);invariant(pkg.pnpm===undefined&&pkg.workspaces===undefined&&pkg.devEngines===undefined);if(path===".")invariant(pkg.packageManager===`pnpm@${PC_PNPM_VERSION}`);else invariant(pkg.packageManager===undefined||pkg.packageManager===`pnpm@${PC_PNPM_VERSION}`);
   manifests.set(path,pkg);
  }
  const vendors=new Set<string>();
  for(const [path,pkg] of manifests){const importer=record(importers[path]);invariant(Object.keys(importer).every(k=>groups.includes(k as typeof groups[number])));const clean:Record<string,unknown>={name:pkg.name,version:pkg.version,private:true,...(path==="."?{packageManager:`pnpm@${PC_PNPM_VERSION}`}:{})};
   for(const group of groups){const declared=pkg[group]===undefined?{}:record(pkg[group]),locked=importer[group]===undefined?{}:record(importer[group]);invariant(Object.keys(declared).length===Object.keys(locked).length);if(pkg[group]!==undefined)clean[group]=declared;
    for(const [n,value] of Object.entries(declared)){name(n);specification(value,n);const entry=record(locked[n]);invariant(Object.keys(entry).length===2&&entry.specifier===value);const version=string(entry.version);
     if((value as string).startsWith("workspace:")){invariant(version.startsWith("link:"));const target=posix.normalize(posix.join(path==="."?"":path,version.slice(5)));invariant(target!=="."&&!target.startsWith("../")&&names.get(n)===target&&manifests.has(target));}
     else if((value as string).startsWith("file:")){const vendor=vendorPath(value),target=relativePath(posix.join(path==="."?"":path,vendor));invariant(reference(version)==="file:"+target);vendors.add(target);}
     else invariant(Object.hasOwn(packages,n+"@"+reference(version)));
    }
   }
   if(pkg.peerDependencies!==undefined){const peers=record(pkg.peerDependencies);for(const [n,v]of Object.entries(peers)){name(n);specification(v,n);}clean.peerDependencies=peers;}if(pkg.peerDependenciesMeta!==undefined)clean.peerDependenciesMeta=record(pkg.peerDependenciesMeta);
   files.set(path==="."?"package.json":path+"/package.json",Buffer.from(JSON.stringify(clean)));
  }
  invariant(Object.keys(packages).length>0&&Object.keys(packages).length<=2500);let total=0;
  for(const [key,input]of Object.entries(packages)){const split=key.lastIndexOf("@"),n=name(key.slice(0,split)),version=key.slice(split+1),entry=record(input),resolution=record(entry.resolution);invariant(Object.keys(resolution).every(k=>["integrity","tarball"].includes(k)));const expected=sri(resolution.integrity);
   if(version.startsWith("file:")){invariant(n==="@flora/ota"&&resolution.tarball===version);const path=vendorPath(version);invariant(vendors.has(path));const bytes=await readBoundedFile(base,path,16*1024*1024);invariant("sha512-"+createHash("sha512").update(bytes).digest("base64")===expected);total+=bytes.length;invariant(total<=64*1024*1024);files.set(path,bytes);vendors.delete(path);}else{invariant(exactVersion.test(version));if(resolution.tarball!==undefined)registryTarball(resolution.tarball);}
   for(const group of ["peerDependencies"]){if(entry[group]!==undefined)for(const [dep,v]of Object.entries(record(entry[group]))){name(dep);specification(v,dep);}}
  }
  invariant(vendors.size===0);
  const snapshots=record(lock.snapshots);invariant(Object.keys(snapshots).length>0&&Object.keys(snapshots).length<=4000);
  for(const [key,input]of Object.entries(snapshots)){string(key,16384);const baseKey=key.split("(")[0]!;invariant(Object.hasOwn(packages,baseKey));reference(key.slice(baseKey.lastIndexOf("@")+1));const snapshot=record(input);if(snapshot.transitivePeerDependencies!==undefined){invariant(Array.isArray(snapshot.transitivePeerDependencies)&&snapshot.transitivePeerDependencies.length<=256);snapshot.transitivePeerDependencies.forEach(name);}invariant(snapshot.optional===undefined||typeof snapshot.optional==="boolean");invariant(Object.keys(snapshot).every(k=>["dependencies","optionalDependencies","transitivePeerDependencies","optional"].includes(k)));for(const group of ["dependencies","optionalDependencies"]){if(snapshot[group]!==undefined)for(const [dep,v]of Object.entries(record(snapshot[group]))){name(dep);invariant(Object.hasOwn(packages,dep+"@"+reference(v)));}}}
  const patches=workspace.patchedDependencies===undefined?{}:record(workspace.patchedDependencies),hashes=lock.patchedDependencies===undefined?{}:record(lock.patchedDependencies);invariant(Object.keys(patches).length===Object.keys(hashes).length&&Object.keys(patches).length<=32);
  for(const [n,p]of Object.entries(patches)){invariant(Object.hasOwn(packages,n));const path=relativePath(string(p,256));invariant(/^patches\/[A-Za-z0-9@._-]+\.patch$/.test(path)&&typeof hashes[n]==="string"&&/^[a-f0-9]{64}$/.test(hashes[n] as string));const bytes=await readBoundedFile(base,path,1024*1024);invariant(createHash("sha256").update(bytes).digest("hex")===hashes[n]);files.set(path,bytes);}
  // Exact importer list and patches survive; build allowances, app hooks, source and credentials do not.
  files.set("pnpm-lock.yaml",lockBytes);files.set("pnpm-workspace.yaml",Buffer.from(stringify({packages:paths.filter(p=>p!=="."),...(Object.keys(patches).length?{patchedDependencies:patches}:{})})));
  await mkdir(destination,{mode:0o700});for(const [path,bytes]of files){await mkdir(dirname(join(destination,path)),{recursive:true,mode:0o700});await writeFile(join(destination,path),bytes,{mode:0o444});}
 }catch{throw new Error("DEPENDENCY_CACHE_INVALID");}
}

/** PNPM 11.10 stores an index link back to its temporary project. Do not export
 * that link to another container; all package-cache links remain forbidden. */
export async function preparePnpmCacheForTransfer(cache:string,seed:string):Promise<void>{
 try{
  const rootStat=await lstat(cache);invariant(rootStat.isDirectory()&&!rootStat.isSymbolicLink());
  const root=await realpath(cache),project=await realpath(seed),registrations:{path:string;ino:number;dev:number}[]=[];let entries=0,bytes=0;
  async function walk(directory:string):Promise<void>{
   for(const entry of await readdir(directory,{withFileTypes:true})){
    invariant(++entries<=120000);const path=join(directory,entry.name),stat=await lstat(path),relative=path.slice(root.length+1).split(sep).join("/");
    if(stat.isSymbolicLink()){
     invariant(/^v11\/projects\/[a-f0-9]{32}$/.test(relative)&&await readlink(path)==="../../../../seed"&&await realpath(path)===project);
     registrations.push({path,ino:stat.ino,dev:stat.dev});
    }else if(stat.isDirectory())await walk(path);
    else{invariant(stat.isFile()&&stat.nlink===1);bytes+=stat.size;invariant(bytes<=1024*1024*1024);}
   }
  }
  await walk(root);
  for(const registration of registrations){const current=await lstat(registration.path);invariant(current.isSymbolicLink()&&current.ino===registration.ino&&current.dev===registration.dev&&await readlink(registration.path)==="../../../../seed");await unlink(registration.path);}
 }catch{throw new Error("DEPENDENCY_CACHE_INVALID");}
}

/** Always copy the read-only transferred cache before PNPM may hardlink packages.
 * Repository export can then change its own tmpfs bytes, never the host cache. */
export async function copyPnpmCacheForCompilation(source:string,destination:string):Promise<void>{
 const stat=await lstat(source);invariant(stat.isDirectory()&&!stat.isSymbolicLink(),"DEPENDENCY_CACHE_INVALID");
 try{await lstat(destination);throw new Error("DEPENDENCY_CACHE_INVALID");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 await mkdir(dirname(destination),{recursive:true});await cp(source,destination,{recursive:true,dereference:false});
}
