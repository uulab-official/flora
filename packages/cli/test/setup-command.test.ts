import test from "node:test";
import assert from "node:assert/strict";
const modulePath="../dist/setup-command.js";
const load=()=>import(modulePath);
test("setup_command_accepts_only_approved_forms",async()=>{
 const {runSetupCommand}=await load();let calls=0;const reports:unknown[]=[];
 const io={choose:async()=>"existing",readPublic:async()=>"",readSecret:async()=>{throw Error("unexpected");},confirm:async()=>false,report:(r:unknown)=>reports.push(r)};
 const handler=async()=>{calls++;return {state:"needs-operator",code:"CONTINUE_IN_BROWSER"};};
 const deps={newInstall:handler,existing:handler,runner:handler,resume:handler,inspect:handler,renew:handler};
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
 const deps={newInstall:handler,existing:handler,runner:handler,resume:handler,renew:handler,inspect:async()=>({state:"needs-operator",code:"LOCAL_ONLY"})};
 assert.equal(await runSetupCommand(["inspect","--state","/private/state.json","--json"],io,deps),0);assert.equal(writes,0);
 const cancelled={...io,choose:async()=>{throw Error("SETUP_CANCELLED");}};
 assert.equal(await runSetupCommand([],cancelled,deps),130);assert.equal(writes,0);
});
test("renew_is_an_explicit_command_and_never_falls_back_to_initial_enrollment",async()=>{
 const {runSetupCommand}=await load();const paths:string[]=[],reports:unknown[]=[];
 const io={choose:async()=>"new",readPublic:async()=>"",readSecret:async()=>{throw Error("no credentials in CLI");},confirm:async()=>true,report:(r:unknown)=>reports.push(r)};
 const forbidden=async()=>{assert.fail("renew must not create or resume an installation implicitly");};
 const deps={newInstall:forbidden,existing:forbidden,runner:forbidden,resume:forbidden,inspect:forbidden,renew:async(path:string)=>{paths.push(path);return {state:"needs-operator",code:"SETUP_OWNER_CONFIRMATION_REQUIRED"};}};
 assert.equal(await runSetupCommand(["renew","--state","/private/state.json"],io,deps),0);
 assert.deepEqual(paths,["/private/state.json"]);
 assert.deepEqual(reports,[{state:"needs-operator",code:"SETUP_OWNER_CONFIRMATION_REQUIRED"}]);
 for(const args of [["renew"],["renew","--state","relative"],["renew","--state","/private/state.json","--token","synthetic-secret"]])assert.equal(await runSetupCommand(args,io,deps),2);
 assert.equal(paths.length,1);assert.ok(!JSON.stringify(reports).includes("synthetic-secret"));
});
