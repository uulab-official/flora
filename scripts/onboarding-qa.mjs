#!/usr/bin/env node
import {mkdir,writeFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readPublicJSON} from './onboarding-download-qa.mjs';
const check=v=>{if(!v)throw Error('ONBOARDING_RECEIPT_INVALID');};
const object=(v,keys)=>{check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)));};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),id=v=>typeof v==='string'&&/^[a-z][a-z0-9_-]{2,95}$/.test(v),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v),count=v=>Number.isSafeInteger(v)&&v>=0;
export function validateReceipts(v){
 object(v,['schemaVersion','evidence','apps','preservation','queries']);check(v.schemaVersion===1&&['fixture','remote-publication'].includes(v.evidence)&&Array.isArray(v.apps)&&v.apps.length>=1&&v.apps.length<=10);
 for(const a of v.apps){object(a,['appId','commitSha','publications']);check(id(a.appId)&&typeof a.commitSha==='string'&&/^[a-f0-9]{40}$/.test(a.commitSha)&&Array.isArray(a.publications)&&a.publications.length>=1&&a.publications.length<=2);
  for(const p of a.publications){object(p,['platform','jobId','deploymentId','assetHashes']);check(['ios','android'].includes(p.platform)&&typeof p.jobId==='string'&&p.jobId.startsWith('automation_')&&uuid(p.jobId.slice(11))&&uuid(p.deploymentId)&&Array.isArray(p.assetHashes)&&p.assetHashes.length>=1&&p.assetHashes.length<=65&&p.assetHashes.every(hash));}
  check(new Set(a.publications.map(p=>p.platform)).size===a.publications.length);
 }
 check(new Set(v.apps.map(a=>a.appId)).size===v.apps.length);object(v.preservation,['sourceHash','unchanged']);check(hash(v.preservation.sourceHash)&&v.preservation.unchanged===true);object(v.queries,['count','rowsRead','writes']);check(Object.values(v.queries).every(count));return structuredClone(v);
}
export async function main(args){check(args.length===4&&args[0]==='--record'&&args[2]==='--out'&&isAbsolute(args[1])&&isAbsolute(args[3]));const result=validateReceipts(await readPublicJSON(args[1]));await mkdir(args[3],{mode:0o700});await writeFile(join(args[3],'receipts.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});return result;}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('ONBOARDING_RECEIPT_INVALID');process.exitCode=1;});
