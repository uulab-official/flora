import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { dirname, join, isAbsolute, normalize, parse } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseJournal, requireSetup, type SetupJournal } from "./contracts.js";

const unsafe="SETUP_PRIVATE_PATH_UNSAFE";
function uid():number { requireSetup(typeof process.getuid==="function",unsafe); return process.getuid(); }
function privateFile(s:Stats):void {requireSetup(s.isFile() && s.uid===uid() && s.nlink===1 && (s.mode&0o7777)===0o600,unsafe);}
function same(a:Stats,b:Stats):boolean {return a.dev===b.dev && a.ino===b.ino;}
/** Does not repair permissions or silently normalize a symlink/alias. */
export async function verifyPrivateDirectory(directory:string):Promise<void> {
  requireSetup(isAbsolute(directory) && normalize(directory)===directory && !directory.includes("\0"),unsafe);
  let current=parse(directory).root;
  for(const part of directory.slice(current.length).split("/").filter(Boolean)){
    current=join(current,part);const s=await fs.lstat(current);
    requireSetup(s.isDirectory() && !s.isSymbolicLink() && (s.uid===0 || s.uid===uid()),unsafe);
    requireSetup((s.mode&0o022)===0 || (s.uid===0 && (s.mode&0o1000)!==0),unsafe);
  }
  const s=await fs.lstat(directory);
  requireSetup(s.uid===uid() && (s.mode&0o7777)===0o700 && await fs.realpath(directory)===directory,unsafe);
}
async function checkParent(file:string):Promise<string> {
  requireSetup(isAbsolute(file) && normalize(file)===file && !file.endsWith("/") && !file.includes("\0"),unsafe);
  const parent=dirname(file);
  await verifyPrivateDirectory(parent);return parent;
}
export async function syncPrivateDirectory(directory:string):Promise<void> {
  await verifyPrivateDirectory(directory);
  const before=await fs.lstat(directory),handle=await fs.open(directory,constants.O_RDONLY|constants.O_NOFOLLOW);
  try { requireSetup(same(before,await handle.stat()),unsafe);await handle.sync();requireSetup(same(before,await fs.lstat(directory)),unsafe); }
  finally{await handle.close();}
}
export async function createPrivateDirectory(directory:string):Promise<void>{
  // The immediate parent may be an owned non-private HOME; verify all ancestry by
  // creating only this final component, then enforcing the full directory check.
  requireSetup(isAbsolute(directory) && normalize(directory)===directory && await fs.realpath(dirname(directory))===dirname(directory),unsafe);
  await fs.mkdir(directory,{mode:0o700});
  await syncPrivateDirectory(directory);
  // The ledger must remain reachable after power loss, not just its contents.
  // Directory fsync does not persist its own entry in the parent directory.
  const parent=dirname(directory),before=await fs.lstat(parent);
  const handle=await fs.open(parent,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    requireSetup(same(before,await handle.stat()),unsafe);
    await handle.sync();
    requireSetup(same(before,await fs.lstat(parent)),unsafe);
    await verifyPrivateDirectory(directory);
  }finally{await handle.close();}
}
export async function readPrivateFile(file:string,maxBytes=16384):Promise<Buffer>{
  try{
    const parent=await checkParent(file),before=await fs.lstat(file);privateFile(before);requireSetup(before.size<=maxBytes,unsafe);
    const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const opened=await handle.stat();privateFile(opened);requireSetup(same(before,opened),unsafe);
      const bytes=Buffer.alloc(maxBytes+1);let length=0;
      while(length<=maxBytes){const r=await handle.read(bytes,length,maxBytes+1-length,null);if(!r.bytesRead)break;length+=r.bytesRead;}
      requireSetup(length<=maxBytes && same(opened,await fs.lstat(file)),unsafe);
      await verifyPrivateDirectory(parent);return bytes.subarray(0,length);
    }finally{await handle.close();}
  }catch{throw new Error(unsafe);}
}
export async function writePrivateFile(file:string,bytes:Uint8Array):Promise<void>{
  try{
    const parent=await checkParent(file);await syncPrivateDirectory(parent);
    const handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{const s=await handle.stat();privateFile(s);await handle.writeFile(bytes);await handle.sync();requireSetup(same(s,await fs.lstat(file)),unsafe);}
    finally{await handle.close();}
    await syncPrivateDirectory(parent);
  }catch{throw new Error(unsafe);}
}
async function locked<T>(directory:string,name:string,action:()=>Promise<T>):Promise<T>{
  const file=join(directory,name);let own:Stats|undefined;
  try{
    await syncPrivateDirectory(directory);
    await writePrivateFile(file,Buffer.from("locked\n"));own=await fs.lstat(file);
    return await action();
  }finally{
    // Only release a lock acquired by this call. A crash leaves it in place.
    if(own){await verifyPrivateDirectory(directory);const current=await fs.lstat(file);privateFile(current);requireSetup(same(own,current),unsafe);await fs.unlink(file);await syncPrivateDirectory(directory);}
  }
}
export async function withSetupLock<T>(directory:string,action:()=>Promise<T>):Promise<T>{
  try{return await locked(directory,".setup.lock",action);}catch{throw new Error("SETUP_LOCK_OR_OPERATION_FAILED");}
}
export async function createJournal(file:string,value:SetupJournal):Promise<void>{
  const parsed=parseJournal(value),parent=dirname(file);
  try{await fs.lstat(parent);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;await createPrivateDirectory(parent);}
  await writePrivateFile(file,Buffer.from(JSON.stringify(parsed)+"\n"));
}
export async function readJournal(file:string):Promise<SetupJournal>{
  const bytes=await readPrivateFile(file);
  try{return parseJournal(JSON.parse(bytes.toString("utf8")));}catch{throw new Error("SETUP_STATE_INVALID");}
}
export async function replaceJournal(file:string,expectedDigest:string,value:SetupJournal):Promise<void>{
  const parsed=parseJournal(value);
  try{
    const parent=await checkParent(file);
    // Separate write lock allows a provisioning transaction to hold .setup.lock.
    await locked(parent,".journal-write.lock",async()=>{
      const before=await readPrivateFile(file);
      requireSetup(createHash("sha256").update(before).digest("hex")===expectedDigest,"SETUP_STATE_DRIFT");
      const temp=join(parent,".journal-"+randomUUID());
      await writePrivateFile(temp,Buffer.from(JSON.stringify(parsed)+"\n"));
      const again=await readPrivateFile(file);
      requireSetup(createHash("sha256").update(again).digest("hex")===expectedDigest,"SETUP_STATE_DRIFT");
      await fs.rename(temp,file);await syncPrivateDirectory(parent);
    });
  }catch{throw new Error("SETUP_STATE_WRITE_FAILED");}
}
