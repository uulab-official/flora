import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import * as source from "../dist/source.js";
const api=source as unknown as {withGitObjectBudget(root:string,bytes:number,signal:AbortSignal,download:(signal:AbortSignal)=>Promise<void>):Promise<void>};
test("source fetch aborts while Git object storage exceeds its download budget",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-budget-"));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,".git/objects/pack"),{recursive:true});
 let aborted=false;await assert.rejects(api.withGitObjectBudget(root,16,new AbortController().signal,async signal=>{await writeFile(join(root,".git/objects/pack/temporary"),Buffer.alloc(33));await new Promise<void>((resolve,reject)=>{signal.addEventListener("abort",()=>{aborted=true;reject(new Error("aborted"));},{once:true});setTimeout(resolve,2000).unref();});}),/SOURCE_UNAVAILABLE/);assert.equal(aborted,true);
});
