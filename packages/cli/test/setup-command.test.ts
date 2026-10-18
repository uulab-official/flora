import test from "node:test";
import assert from "node:assert/strict";
const modulePath="../dist/setup-command.js";
const load=()=>import(modulePath);
test("setup_command_accepts_only_approved_forms",async()=>{
 const {runSetupCommand}=await load();let calls=0;const reports:unknown[]=[];
 const io={choose:async()=>"existing",readPublic:async()=>"",readSecret:async()=>{throw Error("unexpected");},confirm:async()=>false,report:(r:unknown)=>reports.push(r)};
 const handler=async()=>{calls++;return {state:"needs-operator",code:"CONTINUE_IN_BROWSER"};};
 const deps={newInstall:handler,existing:handler,runner:handler,resume:handler,inspect:handler};
 for(const args of [[],["runner"],["--resume","/private/state.json"],["inspect","--state","/private/state.json","--json"]]) assert.equal(await runSetupCommand(args,io,deps),0);
 for(const mode of ["new","runner"])assert.equal(await runSetupCommand([],{...io,choose:async()=>mode},deps),0);
 assert.equal(calls,6);
 for(const args of [["--token","synthetic-secret"],["--password","synthetic-secret"],["runner","runner"],["--exec","sh"],["--resume","relative"],["inspect","--state","/tmp/x"],["--resume","/tmp/x","--resume","/tmp/x"]]) assert.equal(await runSetupCommand(args,io,deps),2);
 assert.equal(calls,6);assert.ok(!JSON.stringify(reports).includes("synthetic-secret"));
});
test("inspect_never_calls_provider_and_cancel_never_mutates",async()=>{
 const {runSetupCommand}=await load();let writes=0;
 const io={choose:async()=>"new",readPublic:async()=>"",readSecret:async()=>"",confirm:async()=>false,report:()=>{}};
 const handler=async()=>{writes++;return {state:"ready",code:"OK"};};
 const deps={newInstall:handler,existing:handler,runner:handler,resume:handler,inspect:async()=>({state:"needs-operator",code:"LOCAL_ONLY"})};
 assert.equal(await runSetupCommand(["inspect","--state","/private/state.json","--json"],io,deps),0);assert.equal(writes,0);
 const cancelled={...io,choose:async()=>{throw Error("SETUP_CANCELLED");}};
 assert.equal(await runSetupCommand([],cancelled,deps),130);assert.equal(writes,0);
});
