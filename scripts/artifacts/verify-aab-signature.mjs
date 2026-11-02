import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotSignaturePolicy, validateSignatureEvidence } from './aab-signature-policy.mjs';
import { snapshotBuildScope } from './build-lifecycle.mjs';
import { copyVerifiedNativeArtifact } from './verified-copy.mjs';
import { verifyNativeArtifactFile } from './native-artifact-file.mjs';
import { privateDirectory } from './private-paths.mjs';
import { checkExecutable, cleanEnvironment } from './build-source.mjs';
const helper = fileURLToPath(new URL('./java/FloraAabVerifier.java', import.meta.url));
const allowedErrors = new Set(['ARTIFACT_SIGNATURE_INVALID','ARTIFACT_SIGNATURE_UNSIGNED','ARTIFACT_SIGNATURE_SIGNER_MISMATCH','ARTIFACT_SIGNATURE_CERTIFICATE_INVALID','ARTIFACT_SIGNATURE_LAYOUT_INVALID','ARTIFACT_SIGNATURE_LIMIT']);
function checkAbort(signal) { if (signal?.aborted) throw new Error('BUILD_PROCESS_ABORTED'); }
function execute(policy, path, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(policy.javaExecutable, ['-Xmx256m','-Djava.awt.headless=true','--source','17',helper,path,policy.expectedSignerSha256], { env: cleanEnvironment(), shell: false, detached: true, stdio: ['ignore','pipe','pipe'] });
    let reason, bytes = 0, stdout = '', stderr = '', grace;
    const stop = code => { if (reason) return; reason=code; if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{};
      grace=setTimeout(()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{};},250); };
    const aborted=()=>stop('BUILD_PROCESS_ABORTED'),timer=setTimeout(()=>stop('ARTIFACT_SIGNATURE_TIMEOUT'),policy.timeoutMs);
    signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
    for(const [kind,stream] of [['out',child.stdout],['err',child.stderr]])stream.on('data',chunk=>{
      bytes+=chunk.length;if(bytes>16384){stop('ARTIFACT_SIGNATURE_OUTPUT_LIMIT');return;}
      if(kind==='out')stdout+=chunk.toString('utf8');else stderr+=chunk.toString('utf8');
    });
    child.once('error',()=>{reason??='ARTIFACT_SIGNATURE_TOOL_UNAVAILABLE';});
    child.once('exit',()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{};});
    child.once('close',code=>{clearTimeout(timer);clearTimeout(grace);signal?.removeEventListener('abort',aborted);
      if(reason)return reject(new Error(reason));
      if(code!==0)return reject(new Error(allowedErrors.has(stderr.trim())?stderr.trim():'ARTIFACT_SIGNATURE_TOOL_FAILED'));
      try {const result=JSON.parse(stdout);if(!result||typeof result!=='object'||Object.keys(result).sort().join(',')!=='certificateNotAfter,certificateNotBefore,javaFeature,signedEntries,signerSha256')throw new Error();resolve(result);}
      catch{reject(new Error('ARTIFACT_SIGNATURE_RESULT_INVALID'));}
    });
  });
}
// Only consumes a public certificate pin, never private keys/keystores. Input bytes are staged privately.
export async function verifyAabSignature({ directory, filePath, manifest, expected, policy, signal }) {
  policy=snapshotSignaturePolicy(policy);expected=Object.freeze({...expected,...snapshotBuildScope(expected)});manifest=Object.freeze({...manifest});
  if(expected.platform!=='android')throw new Error('ARTIFACT_SIGNATURE_POLICY_INVALID');
  checkAbort(signal);directory=await privateDirectory(directory);
  try{await checkExecutable(policy.javaExecutable);}catch{throw new Error('ARTIFACT_SIGNATURE_TOOL_UNAVAILABLE');}
  let staging;
  try {
    staging=await mkdtemp(join(directory,'.signature-'));const target=join(staging,'candidate.aab');
    await copyVerifiedNativeArtifact({sourcePath:filePath,targetPath:target,manifest,expected});checkAbort(signal);
    const observed=await execute(policy,target,signal);checkAbort(signal);
    await verifyNativeArtifactFile({filePath:target,manifest,expected});checkAbort(signal);
    return validateSignatureEvidence({version:1,scheme:'aab-jar-v1',verifier:'flora-jarfile-v1',sha256:manifest.sha256,byteCount:manifest.byteCount,
      ...observed,verifiedAt:new Date().toISOString(),bundleValidated:false,installVerified:false}, {...manifest,format:'aab'}, {scheme:policy.scheme,signerSha256:policy.expectedSignerSha256});
  } finally {if(staging)await rm(staging,{recursive:true,force:true});}
}
