import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const load = async () => {
  const modulePath = "../dist/setup/private-files.js";
  return import(modulePath);
};
const journal = () => ({ schemaVersion: 1, plan: {
  installationId: "install-1234", accountId: "a".repeat(32), workerName: "flora-qa-install-1234",
  databaseName: "flora-qa-install-1234", hostname: "qa.example.com", zoneId: "b".repeat(32),
  origin: "https://qa.example.com", ownerEmail: "owner@example.com", ownerId: "qa-owner",
  dbIdentity: "11111111-1111-4111-8111-111111111111",
}, stage: "planned", receipts: [], setup: null });
async function fixture(t: {after(fn:()=>Promise<void>):void}) {
  const dir = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "flora setup "));
  t.after(() => fs.rm(dir, {recursive:true,force:true}));
  return {dir, file:join(dir,"private","journal.json")};
}
function hash(bytes:Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }

test("exclusive_creation_keeps_existing_bytes", async t => {
  const {file,dir}=await fixture(t), api=await load();
  await api.createJournal(file,journal());
  const original=await fs.readFile(file);
  assert.equal((await fs.stat(join(dir,"private"))).mode & 0o777,0o700);
  assert.equal((await fs.stat(file)).mode & 0o777,0o600);
  await assert.rejects(api.createJournal(file,journal()));
  assert.deepEqual(await fs.readFile(file),original);
  assert.deepEqual(await api.readJournal(file),journal());
});
test("private_path_rejects_alias_symlink_hardlink_shared_parent", async t => {
  const {file,dir}=await fixture(t), api=await load();
  await api.createJournal(file,journal());
  await fs.symlink(join(dir,"private"),join(dir,"alias"));
  await assert.rejects(api.readJournal(join(dir,"alias","journal.json")));
  if (process.platform === "darwin") await assert.rejects(api.readJournal(file.replace(/^\/private\/var\//,"/var/")));
  await fs.link(file,join(dir,"second-link"));
  await assert.rejects(api.readJournal(file));
  await fs.unlink(join(dir,"second-link"));
  await fs.chmod(join(dir,"private"),0o755);
  await assert.rejects(api.readJournal(file));
  assert.equal((await fs.stat(join(dir,"private"))).mode&0o777,0o755);
});
test("crash_before_rename_preserves_journal", async t => {
  const {file}=await fixture(t), api=await load();
  await api.createJournal(file,journal());
  const before=await fs.readFile(file);
  const patch=mock.method(fs,"rename",async()=>{throw new Error("synthetic-private-error");});
  try { await assert.rejects(api.replaceJournal(file,hash(before),{...journal(),stage:"database-created"}), e=>e instanceof Error && !e.message.includes("synthetic-private-error")); }
  finally {patch.mock.restore();}
  assert.deepEqual(await fs.readFile(file),before);
});
test("concurrent_writer_and_digest_drift_reject", async t => {
  const {file,dir}=await fixture(t), api=await load();
  await api.createJournal(file,journal());
  let entered!:()=>void, release!:()=>void;
  const started=new Promise<void>(r=>{entered=r;}), gate=new Promise<void>(r=>{release=r;});
  const one=api.withSetupLock(join(dir,"private"),async()=>{entered();await gate;});
  await started;
  await assert.rejects(api.withSetupLock(join(dir,"private"),async()=>assert.fail("second writer entered")));
  release(); await one;
  const before=await fs.readFile(file);
  await assert.rejects(api.replaceJournal(file,"0".repeat(64),{...journal(),stage:"database-created"}));
  assert.deepEqual(await fs.readFile(file),before);
  await api.replaceJournal(file,hash(before),{...journal(),stage:"database-created"});
  assert.equal((await api.readJournal(file)).stage,"database-created");
});
test("unsafe_schema_and_unavailable_directory_sync_stop_before_action",async t=>{
 const {file,dir}=await fixture(t),api=await load();
 await assert.rejects(api.createJournal(file,{...journal(),token:"synthetic-private"}));
 await api.createJournal(file,journal());
 await fs.writeFile(file,'{"token":"synthetic-private"', {mode:0o600});
 await assert.rejects(api.readJournal(file),e=>e instanceof Error && e.message==="SETUP_STATE_INVALID");
 const open=fs.open.bind(fs);
 const patch=mock.method(fs,"open",async(...args:Parameters<typeof fs.open>)=>{
   const handle=await open(...args);
   if(args[0]===join(dir,"private")) mock.method(handle,"sync",async()=>{throw new Error("no-fsync");});
   return handle;
 });
 let calls=0;
 try {await assert.rejects(api.withSetupLock(join(dir,"private"),async()=>{calls++;}));}
 finally{patch.mock.restore();}
 assert.equal(calls,0);
});
