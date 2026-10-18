import test from "node:test";
import assert from "node:assert/strict";
import {PassThrough} from "node:stream";
const terminal="../dist/setup/terminal.js", runtime="../dist/setup/runtime.js";
function input(){return Object.assign(new PassThrough(),{isTTY:true,isRaw:false,setRawMode(raw:boolean){this.isRaw=raw;return this;}});}
test("secret_paste_framing_and_tty_restore",async()=>{
 const {readSecret}=await import(terminal);
 for(const framing of ["\n","\r\n"]){
  const stream=input(),output=new PassThrough();let printed="";output.on("data",b=>{printed+=b;});
  const result=readSecret(stream,output,"Runner token: ",new AbortController().signal);
  stream.write("synthetic-secret "+framing);
  assert.equal(await result,"synthetic-secret ");assert.equal(stream.isRaw,false);assert.ok(!printed.includes("synthetic-secret"));
 }
});
test("secret_eof_ctrl_c_non_tty_abort_and_size_restore",async()=>{
 const {readSecret}=await import(terminal);
 for(const event of ["eof","ctrl-c","abort","size"]){
  const stream=input(),out=new PassThrough(),ctl=new AbortController();
  const result=readSecret(stream,out,"Token: ",ctl.signal);
  if(event==="eof")stream.end();else if(event==="abort")ctl.abort();else stream.write(event==="size"?"s".repeat(4097):"\x03");
  await assert.rejects(result);assert.equal(stream.isRaw,false);
 }
 const stream=input();stream.isTTY=false;
 await assert.rejects(readSecret(stream,new PassThrough(),"Token: ",new AbortController().signal));
});
test("bounded_tools_never_leak_errors_and_kill_timeout_or_excess_output",async()=>{
 const {runBoundedTool}=await import(runtime);
 const options={cwd:process.cwd(),timeoutMs:1000,maxBytes:256,signal:new AbortController().signal};
 const good=await runBoundedTool(process.execPath,["-e","process.stdout.write('ok')"],options);assert.deepEqual(good,{exitCode:0,stdout:"ok"});
 await assert.rejects(runBoundedTool(process.execPath,["-e","console.error('synthetic-secret');process.exit(3)"],options),e=>e instanceof Error && !e.message.includes("synthetic-secret"));
 await assert.rejects(runBoundedTool(process.execPath,["-e","console.log('s'.repeat(500))"],options),/SETUP_TOOL_OUTPUT_LIMIT/);
 await assert.rejects(runBoundedTool(process.execPath,["-e","setInterval(()=>{},1000)"],{...options,timeoutMs:100}),/SETUP_TOOL_TIMEOUT/);
});
test("provider_tool_capture_disables_wrangler_disk_logs",async()=>{
 const {runBoundedTool}=await import(runtime);
 const result=await runBoundedTool(process.execPath,["-e","process.stdout.write(process.env.WRANGLER_WRITE_LOGS ?? 'missing')"],{cwd:process.cwd(),timeoutMs:1000,maxBytes:256,signal:new AbortController().signal});
 assert.equal(result.stdout,"false");
});
