import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createPasswordVerifier} from '../dist/auth/password.js';
import {createTestRuntime} from './runtime.ts';
export const orgOrigin = 'https://organization.example.test';
export async function createOrgFixture(t:TestContext,bindings:NonNullable<import('./runtime.ts').TestRuntimeOptions['bindings']>={}) {
  const runtime=await createTestRuntime({entrypoint:new URL('./fixtures/org-entry.ts',import.meta.url),durableObjects:{FLORA_AUTH:'OrgFixture'},bindings:{
    FLORA_ORIGIN:orgOrigin,FLORA_OWNER_ID:'synthetic-owner',FLORA_OWNER_EMAIL:'Owner@example.test',FLORA_DB_IDENTITY:'synthetic-db',...bindings}});
  t.after(()=>runtime.dispose());
  const control=(body:Record<string,unknown>)=>runtime.fetch(orgOrigin+'/__test/control',{method:'POST',body:JSON.stringify(body)});
  const sql=async(query:string,args:unknown[]=[])=>{const r=await control({action:'sql',sql:query,args});assert.equal(r.status,200);return await r.json() as any[];};
  const snapshot=async()=>{
    const tables=await sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'flora_org_%' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const rows:Record<string,unknown>={};
    for(const {name} of tables) {
      assert.match(name,/^[A-Za-z0-9_]+$/); rows[name]=await sql('SELECT * FROM "'+name+'" ORDER BY rowid');
    }
    return rows;
  };
  return {runtime,control,sql,snapshot};
}

export interface TestSession {cookie:string;csrfToken:string}
export function sessionCookies(response:{headers:{getSetCookie():string[]}},csrfToken:string):TestSession{return {cookie:response.headers.getSetCookie().map(v=>v.split(';',1)[0]).join('; '),csrfToken}}
export async function createMemberAuthFixture(t:TestContext){
 const now=Date.now(),token=randomBytes(32),ownerPassword='synthetic-owner-password-qa';
 const h=await createOrgFixture(t,{FLORA_SETUP:{digest:createHash('sha256').update(token).digest('hex'),issuedAt:now,expiresAt:now+600_000,generation:1,purpose:'enroll'}});
 await h.control({now});
 const request=(actor:TestSession|null,method:string,path:string,body?:unknown)=>h.runtime.fetch(orgOrigin+path,{method,headers:{...(actor?{Cookie:actor.cookie,'X-Flora-CSRF':actor.csrfToken}:{}),...(method!=='GET'?{Origin:orgOrigin,'Content-Type':'application/json'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const r=await request(null,'POST','/api/auth/enroll',{email:'Owner@example.test',password:ownerPassword,confirmation:ownerPassword,token:token.toString('base64url')});assert.equal(r.status,200);
 const owner=sessionCookies(r,(await r.json() as any).csrfToken);
 assert.equal((await request(owner,'GET','/api/auth/session')).status,200);
 const [org]=await h.sql('SELECT id FROM flora_org_state');
 await h.sql("UPDATE flora_org_state SET mode='active'");
 async function member(role:'admin'|'deployer'|'viewer'='deployer',suffix='a'){
  const userId='user-'+suffix,membershipId='membership-'+suffix,email=suffix+'@example.test',password='synthetic-member-password-'+suffix;
  const verifier=await createPasswordVerifier(password);
  await h.sql("INSERT INTO flora_org_users VALUES(?,?,?,'member','active',1)",[userId,email,'Member '+suffix]);
  await h.sql("INSERT INTO flora_org_memberships VALUES(?,?,?,?,'active',1)",[membershipId,org.id,userId,role]);
  await h.sql('INSERT INTO flora_org_passwords VALUES(?,?)',[userId,JSON.stringify(verifier)]);
  await h.sql('INSERT INTO flora_org_app_access VALUES(?,?,1)',[membershipId,'app_first']);
  return {userId,membershipId,email,password};
 }
 async function login(account:{email:string;password:string}){const response=await request(null,'POST','/api/auth/login',{email:account.email,password:account.password});assert.equal(response.status,200);return sessionCookies(response,(await response.json() as any).csrfToken);}
 return {...h,now,owner,ownerPassword,request,member,login};
}
