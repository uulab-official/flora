import {test} from 'node:test';
import assert from 'node:assert/strict';
import {oidcRequestAddress,validAdmission,safeDiagnostic} from './github-runner-bootstrap.mjs';
test('OIDC request stays at GitHub Actions HTTPS endpoint with explicit audience',()=>{
 const address=oidcRequestAddress('https://run.actions.githubusercontent.com/id?x=1','https://flora.uulab.co.kr');
 assert.equal(address.searchParams.get('audience'),'https://flora.uulab.co.kr');
 for(const input of ['http://run.actions.githubusercontent.com/id','https://actions.githubusercontent.com.evil.test/id','https://evil-actions.githubusercontent.com/id','https://token@run.actions.githubusercontent.com/id','https://run.actions.githubusercontent.com:444/id'])assert.throws(()=>oidcRequestAddress(input,'flora'));
});
test('diagnostics forward only constrained stage and code, excluding arbitrary fields',()=>{
 assert.deepEqual(safeDiagnostic({diagnostic:true,stage:'dependency-preparation',code:'EXECUTION_FAILED',token:'must-never-forward'}),{diagnostic:true,stage:'dependency-preparation',code:'EXECUTION_FAILED'});
 for(const value of [{diagnostic:true,stage:'source\nsecret'},{diagnostic:true,stage:'export',code:'Bearer credential'},{stage:'export'}])assert.equal(safeDiagnostic(value),null);
});
test('admission binds exact app, source commit, one machine and expiry',()=>{
 const now=1000000,app='application_isso',sha='a'.repeat(40),token='runner_isso.'+'b'.repeat(43);
 const value={appId:app,commitSha:sha,expiresAt:now+1800000,token,runner:{id:'runner_isso',appIds:[app]}};
 assert.equal(validAdmission(value,app,sha,now),true);
 for(const bad of [{...value,appId:'application_promise'},{...value,commitSha:'c'.repeat(40)},{...value,expiresAt:now+60000},{...value,expiresAt:String(now+1800000)},{...value,token:token+'\n'},{...value,runner:{id:'runner_promise',appIds:[app]}},{...value,runner:{id:'runner_isso',appIds:[app,'application_promise']}}])assert.equal(!!validAdmission(bad,app,sha,now),false);
});
