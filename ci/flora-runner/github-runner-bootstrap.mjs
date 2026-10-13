/** Trusted GitHub reusable workflow controller. App source never runs here. */
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {pathToFileURL} from 'node:url';

export function oidcRequestAddress(input, audience) {
  const address=new URL(input);
  if(address.protocol!=='https:' || address.port!=='' || address.username || address.password
    || !/^(?:[a-z0-9-]+\.)*actions\.githubusercontent\.com$/i.test(address.hostname)) throw new Error('GITHUB_RUNNER_CONFIGURATION_INVALID');
  address.searchParams.set('audience',audience); return address;
}
export function validAdmission(value, appId, sha, now=Date.now()) {
  return value?.appId===appId && value.commitSha===sha && Number.isSafeInteger(value.expiresAt) && value.expiresAt>now+60000
    && typeof value.token==='string' && /^[a-z][a-z0-9_-]{2,95}\.[A-Za-z0-9_-]{43}$/.test(value.token)
    && value.runner?.id===value.token.split('.')[0] && value.runner.appIds?.length===1 && value.runner.appIds[0]===appId;
}
export function safeDiagnostic(value) {
  return value?.diagnostic===true && typeof value.stage==='string' && /^[a-z][a-z0-9-]{0,63}$/.test(value.stage)
    && (value.code===undefined || typeof value.code==='string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code))
    ? {diagnostic:true,stage:value.stage,...(value.code?{code:value.code}:{})} : null;
}
async function main() {
const origin = 'https://flora.uulab.co.kr';
const appId = process.env.FLORA_APP_ID;
const expectedSha = process.env.GITHUB_SHA;
const baseImage = 'node@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df';
function ensure(value) { if (!value) throw new Error('GITHUB_RUNNER_CONFIGURATION_INVALID'); }
ensure(/^[a-z][a-z0-9_-]{2,95}$/.test(appId ?? '') && /^[a-f0-9]{40}$/.test(expectedSha ?? ''));
ensure(process.getuid?.() > 0);
const tokenAddress = oidcRequestAddress(process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? '',origin);
ensure(typeof process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === 'string' && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0);
tokenAddress.searchParams.set('audience', origin);
async function jsonRequest(address, options) {
  const response = await fetch(address, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
  ensure(response.ok && response.body);
  const reader = response.body.getReader(); let size = 0; const parts = [];
  try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; ensure(size <= 65536); parts.push(item.value); } }
  finally { void reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
const oidc = await jsonRequest(tokenAddress, { headers: { Authorization: 'Bearer ' + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN } });
ensure(typeof oidc.value === 'string' && oidc.value.length < 16384);
const admitted = await jsonRequest(origin + '/api/runner/github/oidc', {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer ' + oidc.value }, body: JSON.stringify({ appId }),
});
ensure(validAdmission(admitted,appId,expectedSha));
// Actions credentials are not needed by the controller's subprocesses.
for (const key of Object.keys(process.env)) if (/^(?:ACTIONS_|GITHUB_TOKEN$|GH_TOKEN$)/.test(key)) delete process.env[key];
oidc.value = '';
const privateRoot = await mkdtemp(join(tmpdir(), 'flora-github-runner-'));
await chmod(privateRoot, 0o700);
const config = join(privateRoot, 'runner.json');
try {
async function dockerCommand(args) {
  const child = spawn('docker', args, {stdio:['ignore','pipe','pipe']}); let size=0;
  for(const stream of [child.stdout,child.stderr]) stream.on('data', part=>{size+=part.length;if(size>2*1024*1024)child.kill('SIGTERM');});
  const timer=setTimeout(()=>child.kill('SIGTERM'),300000);
  try {ensure(await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);})===0 && size<=2*1024*1024);}
  finally {clearTimeout(timer);}
}
await dockerCommand(['pull',baseImage]);
process.stdout.write(JSON.stringify({state:'toolchain-base-verified'})+'\n');
const imageFile=join(privateRoot,'image.id');
await dockerCommand(['build','--network=default','--pull=false','--iidfile',imageFile,'--file','ci/flora-runner/Dockerfile','ci/flora-runner']);
const dockerImage=(await readFile(imageFile,'utf8')).trim(); ensure(/^sha256:[a-f0-9]{64}$/.test(dockerImage));
process.stdout.write(JSON.stringify({state:'toolchain-ready',dockerImage})+'\n');
await writeFile(config, JSON.stringify({ origin, token: admitted.token, dockerImage,
  resourceProfile: 'github-hosted', dependencyPreparation: 'npm-registry', publicationRecovery: 'remote-checkpoint',
  workDirectory: join(privateRoot, 'work'), recoveryDirectory: join(privateRoot, 'recovery') }), { mode: 0o600 });
admitted.token = '';
async function runOnce() {
  const child = spawn(process.execPath, [resolve('ci/flora-runner/dist/main.js'), '--config', config, '--once'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', bytes = 0;
  for (const [stream, append] of [[child.stdout, value => { stdout += value; }], [child.stderr, value => { stderr += value; }]])
    stream.on('data', part => { bytes += part.length; if (bytes > 1048576) child.kill('SIGTERM'); else append(part.toString('utf8')); });
  const exit = await new Promise((resolveExit, reject) => { child.on('error', reject); child.on('close', resolveExit); });
  const lines = stdout.trim().split('\n'); let result;
  for (const line of lines) { try { const item = JSON.parse(line), diagnostic=safeDiagnostic(item); if(diagnostic)process.stdout.write(JSON.stringify(diagnostic)+'\n'); if (typeof item.state === 'string') result = item; } catch {} }
  if (exit !== 0 || !result) {
    const safeCode = stderr.trim().split('\n').find(line => /^[A-Z][A-Z0-9_]{1,95}$/.test(line)) ?? result?.code ?? 'RUNNER_EXECUTION_FAILED';
    process.stdout.write(JSON.stringify({ state: result?.state ?? 'failed', code: safeCode, jobId: result?.jobId }) + '\n');
    throw new Error('RUNNER_EXECUTION_FAILED');
  }
  return result;
}
  // Push workflow and signed webhook may arrive in either order. Wait only for
  // this admitted commit, never turn an empty queue into a successful deploy.
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await runOnce();
    if (result.state === 'succeeded') { process.stdout.write(JSON.stringify({ ...result, appId, commitSha: expectedSha }) + '\n'); break; }
    ensure(result.state === 'empty');
    if (attempt === 19) throw new Error('WEBHOOK_JOB_NOT_READY');
    process.stdout.write(JSON.stringify({ state: 'waiting-for-webhook', appId, attempt: attempt + 1 }) + '\n');
    await new Promise(resolveWait => setTimeout(resolveWait, 3000));
  }
} finally {
  // A server checkpoint, not this disposable VM directory, retains any exact
  // uncertain receipt. Never upload app source or raw bearer credentials.
  await rm(privateRoot, { recursive: true, force: true });
}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(()=>{process.stderr.write('GITHUB_RUNNER_EXECUTION_FAILED\n');process.exitCode=1;});
}
