import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
test("real_pty_hides_secret_and_restores_echo_on_success_and_cancel",t=>{
 if(process.platform==="win32" || spawnSync("python3",["--version"]).status!==0){t.skip("Python/POSIX PTY unavailable; not a PTY pass");return;}
 for(const mode of ["success","cancel"]){
  const r=spawnSync("python3",[fileURLToPath(new URL("./fixtures/setup-terminal-pty.py",import.meta.url)),process.execPath,fileURLToPath(new URL("./fixtures/setup-terminal-child.ts",import.meta.url)),mode],{timeout:20000,encoding:"utf8"});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).passed,true);
 }
});
test("public_prompt_ctrl_c_cancels_without_hanging",t=>{
 if(process.platform==="win32" || spawnSync("python3",["--version"]).status!==0){t.skip("Python/POSIX PTY unavailable");return;}
 const r=spawnSync("python3",[fileURLToPath(new URL("./fixtures/setup-terminal-pty.py",import.meta.url)),process.execPath,fileURLToPath(new URL("./fixtures/setup-terminal-child.ts",import.meta.url)),"public"],{timeout:20000,encoding:"utf8"});
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).passed,true);
});
