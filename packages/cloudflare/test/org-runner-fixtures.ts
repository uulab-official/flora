import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createMemberAuthFixture,orgOrigin} from './org-fixtures.ts';
import {RunnerGate} from '../dist/org/runner-gate.js';

export async function runnerHarness(t:TestContext,bindings:Parameters<typeof createMemberAuthFixture>[1]={},options:Parameters<typeof createMemberAuthFixture>[2]={}){
 const h=await createMemberAuthFixture(t,bindings,options);
 for(const name of ['0001_private_imports.sql','0002_multi_app.sql','0003_github_ota.sql','0004_automation.sql','0014_org_runner_access.sql']){
  const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');await h.runtime.d1.exec(sql.replace(/^--.*$/gm,'').split(/;\s*(?=CREATE|INSERT|DROP|PRAGMA|$)/).filter(s=>s.trim()).map(s=>s.replace(/\s*\n\s*/g,' ').trim()+';').join('\n'));
 }
 await h.runtime.d1.prepare('INSERT INTO flora_deployment VALUES(1,?,?,?)').bind('synthetic-owner',orgOrigin,'synthetic-db').run();
 const apps:string[]=[];for(const name of ['First','Second']){const r=await h.request(h.owner,'POST','/api/apps',{name,repositoryId:name.toLowerCase(),rootDirectory:'.'});assert.equal(r.status,201);apps.push((await r.json()as any).id);}
 const gate=new RunnerGate(h.runtime.d1 as any,'synthetic-owner');await gate.block(1,'operation_fixture_cutover');await gate.seal(1);
 async function account(role:'admin'|'deployer'|'viewer',suffix:string){const user=await h.member(role,suffix);await h.sql('DELETE FROM flora_org_app_access WHERE membership_id=?',[user.membershipId]);await h.sql('INSERT INTO flora_org_app_access VALUES(?,?,1)',[user.membershipId,apps[0]]);return {...user,session:await h.login(user)};}
 const requester=await account('deployer','requester'),approver=await account('admin','approver');
 async function reauth(actor=approver){const r=await h.request(actor.session,'POST','/api/auth/reauth',{password:actor.password});assert.equal(r.status,200);}
 const base='/api/apps/'+apps[0]+'/runner-requests';
 async function requestPC(kind='ota',platforms=['ios','android'],actor=requester){const r=await h.request(actor.session,'POST',base,{kind,name:'QA PC',platforms});assert.equal(r.status,201);return await r.json()as any;}
 async function approve(row:any,actor=approver){const r=await h.request(actor.session,'POST',base+'/'+row.id+'/approve',{expectedRevision:row.revision});assert.equal(r.status,200);return await r.json()as any;}
 const claim=(row:any,actor=requester)=>h.request(actor.session,'POST',base+'/'+row.id+'/claim',{expectedRevision:row.revision});
 async function service(ref:{kind:string;runnerId:string},appId=apps[0],platform='ios'){return h.control({action:'runner-service',ref,appId,platform});}
 await reauth();return {...h,apps,base,gate,account,requester,approver,reauth,requestPC,approve,claim,service};
}
