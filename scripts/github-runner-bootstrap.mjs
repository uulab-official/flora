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
function validPlatforms(platforms) {
  return Array.isArray(platforms) && platforms.length>0 && platforms.length<=2
    && platforms.every(platform=>platform==='ios'||platform==='android') && new Set(platforms).size===platforms.length;
}
/** Only admitted targets may run. Ordinary export failures retain successful siblings. */
export async function runAdmittedPlatforms(platforms,{runOnce,wait=ms=>new Promise(resolveWait=>setTimeout(resolveWait,ms)),onOutcome=()=>{},maxAttempts=20}) {
  if(!validPlatforms(platforms)||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>20)throw new Error('GITHUB_RUNNER_CONFIGURATION_INVALID');
  const outcomes=[];
  for(const platform of platforms) {
    let outcome;
    for(let attempt=0;attempt<maxAttempts;attempt++) {
      const result=await runOnce(platform);
      if(result?.state==='empty') {
        if(Object.keys(result).some(key=>key!=='state'))throw new Error('RUNNER_RESULT_INVALID');
        if(attempt===maxAttempts-1){outcome={state:'failed',platform,code:'WEBHOOK_JOB_NOT_READY'};break;}
        onOutcome({state:'waiting-for-webhook',platform,attempt:attempt+1});await wait(3000);continue;
      }
      if(!result||result.platform!==platform||!['succeeded','failed','interrupted','publication_unknown'].includes(result.state)
        ||typeof result.jobId!=='string'||!/^[a-z][a-z0-9_-]{2,95}$/.test(result.jobId)
        ||result.state==='succeeded'&&(typeof result.deploymentId!=='string'||!/^[a-zA-Z0-9_-]{3,96}$/.test(result.deploymentId))
        ||result.code!==undefined&&(typeof result.code!=='string'||! /^[A-Z][A-Z0-9_]{1,95}$/.test(result.code)))throw new Error('RUNNER_RESULT_INVALID');
      outcome={state:result.state,platform,jobId:result.jobId,...(result.deploymentId?{deploymentId:result.deploymentId}:{}),...(result.code?{code:result.code}:{})};
      if(result.state==='publication_unknown'||result.state==='interrupted') {onOutcome(outcome);throw new Error('PUBLICATION_RECONCILIATION_REQUIRED');}
      break;
    }
    outcomes.push(outcome);onOutcome(outcome);
  }
  if(outcomes.length!==platforms.length||outcomes.some(outcome=>outcome.state!=='succeeded')) {
    const error=new Error('PLATFORM_DEPLOYMENTS_INCOMPLETE');error.outcomes=outcomes;throw error;
  }
  return outcomes;
}
export function initializationDiagnostic(stderr) {
  const code=typeof stderr==='string'?stderr.trim():'';
  if(['TENANT_MISMATCH','IDEMPOTENCY_CONFLICT','INVALID_TRANSITION','PRIVATE_STORE_UNSAFE','STORE_IN_USE','MIGRATION_MISMATCH','INVALID_REQUEST'].includes(code))return {diagnostic:true,stage:'runner-execution',code};
  if(['BUSY','LEASE_STALE','CONFIG_CONFLICT','CONFIG_CHANGED','PERMISSION_DENIED','INVALID_INPUT','INVALID_RELATION','NOT_FOUND','CONFLICT','INPUT_TOO_LARGE','PROVIDER_UNSUPPORTED','PROVIDER_UNCONFIGURED','UNAUTHENTICATED','FORBIDDEN','AUTH_UNAVAILABLE','CI_SESSION_REJECTED','CI_BINDING_REJECTED','CI_COMMIT_SUPERSEDED','CI_IDENTITY_REJECTED','CI_IDENTITY_REPLAYED','CHECKPOINT_CAPACITY','RUNNER_REVOKED','RUNNER_REQUEST_REJECTED','RUNNER_TRANSPORT_UNAVAILABLE','RUNNER_RESPONSE_INVALID','EXPORT_FAILED','SOURCE_UNAVAILABLE','ARTIFACT_INVALID','CANCELLED','LEASE_EXPIRED','PUBLICATION_REJECTED'].includes(code))return {diagnostic:true,stage:'runner-execution',code};
  return ['INVALID_RUNNER_CONFIG','ISOLATION_UNAVAILABLE','ISOLATION_CLEANUP_UNCONFIRMED','PUBLICATION_RECONCILIATION_REQUIRED','INVALID_RECOVERY_JOURNAL','RECOVERY_JOURNAL_UNAVAILABLE','RECOVERY_CLEANUP_UNCONFIRMED','RECOVERY_CHECKPOINT_UNAVAILABLE','PUBLICATION_RESULT_UNCONFIRMED','RUNNER_STOPPED'].includes(code)
    ? {diagnostic:true,stage:'runner-initialization',code} : null;
}
export function platformRunnerConfig(privateRoot,platform,{origin,token,dockerImage}) {
  if(!['ios','android'].includes(platform))throw new Error('GITHUB_RUNNER_CONFIGURATION_INVALID');
  return {origin,token,dockerImage,claimPlatform:platform,resourceProfile:'github-hosted',dependencyPreparation:'npm-registry',publicationRecovery:'remote-checkpoint',
    workDirectory:join(privateRoot,'work-'+platform),recoveryDirectory:join(privateRoot,'recovery-'+platform)};
}
export function validAdmission(value, appId, sha, now=Date.now()) {
  return validPlatforms(value?.platforms) && value?.appId===appId && value.commitSha===sha && Number.isSafeInteger(value.expiresAt) && value.expiresAt>now+60000
    && typeof value.token==='string' && /^[a-z][a-z0-9_-]{2,95}\.[A-Za-z0-9_-]{43}$/.test(value.token)
    && value.runner?.id===value.token.split('.')[0] && value.runner.appIds?.length===1 && value.runner.appIds[0]===appId;
}
export function safeDiagnostic(value) {
  return value?.diagnostic===true && typeof value.stage==='string' && /^[a-z][a-z0-9-]{0,63}$/.test(value.stage)
    && (value.code===undefined || typeof value.code==='string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code))
    && (value.httpStatus===undefined || Number.isInteger(value.httpStatus) && (value.httpStatus===0 || value.httpStatus>=100 && value.httpStatus<=599))
    ? {diagnostic:true,stage:value.stage,...(value.code?{code:value.code}:{}),...(value.httpStatus===undefined?{}:{httpStatus:value.httpStatus})} : null;
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
const token=admitted.token;admitted.token='';
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
async function runOnce(platform) {
  const config=join(privateRoot, 'runner-'+platform+'.json');
  await writeFile(config,JSON.stringify(platformRunnerConfig(privateRoot,platform,{origin,token,dockerImage})),{mode:0o600});
  const child = spawn(process.execPath, [resolve('ci/flora-runner/dist/main.js'), '--config', config, '--once'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', bytes = 0;
  for (const [stream, append] of [[child.stdout, value => { stdout += value; }], [child.stderr, value => { stderr += value; }]])
    stream.on('data', part => { bytes += part.length; if (bytes > 1048576) child.kill('SIGTERM'); else append(part.toString('utf8')); });
  const exit = await new Promise((resolveExit, reject) => { child.on('error', reject); child.on('close', resolveExit); });
  const lines = stdout.trim().split('\n'); let result;
  for (const line of lines) { try { const item = JSON.parse(line), diagnostic=safeDiagnostic(item); if(diagnostic)process.stdout.write(JSON.stringify(diagnostic)+'\n'); if (typeof item.state === 'string') result = item; } catch {} }
  if (bytes>1048576 || !result || exit!==0 && result.state!=='failed' && result.state!=='interrupted' && result.state!=='publication_unknown') {
    const diagnostic=initializationDiagnostic(stderr);if(diagnostic)process.stdout.write(JSON.stringify(diagnostic)+'\n');
    throw new Error('RUNNER_EXECUTION_FAILED');
  }
  if(exit!==0 && result.state==='succeeded')throw new Error('RUNNER_EXECUTION_FAILED');
  return result;
}
  const outcomes=await runAdmittedPlatforms(admitted.platforms,{runOnce,onOutcome:result=>process.stdout.write(JSON.stringify({...result,appId,commitSha:expectedSha})+'\n')});
  process.stdout.write(JSON.stringify({state:'all-platforms-succeeded',appId,commitSha:expectedSha,platforms:outcomes.map(result=>result.platform)})+'\n');
} finally {
  // A server checkpoint, not this disposable VM directory, retains any exact
  // uncertain receipt. Never upload app source or raw bearer credentials.
  await rm(privateRoot, { recursive: true, force: true });
}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(()=>{process.stderr.write('GITHUB_RUNNER_EXECUTION_FAILED\n');process.exitCode=1;});
}
