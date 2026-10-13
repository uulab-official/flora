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
 const value={appId:app,commitSha:sha,expiresAt:now+1800000,token,runner:{id:'runner_isso',appIds:[app]},platforms:['ios']};
 assert.equal(validAdmission(value,app,sha,now),true);
 for(const bad of [{...value,appId:'application_promise'},{...value,commitSha:'c'.repeat(40)},{...value,expiresAt:now+60000},{...value,expiresAt:String(now+1800000)},{...value,token:token+'\n'},{...value,runner:{id:'runner_promise',appIds:[app]}},{...value,runner:{id:'runner_isso',appIds:[app,'application_promise']}}])assert.equal(!!validAdmission(bad,app,sha,now),false);
});
test('admission requires an exact nonempty unique supported platform selection',()=>{
 const now=1000000,app='application_isso',sha='a'.repeat(40),token='runner_isso.'+'b'.repeat(43);
 const base={appId:app,commitSha:sha,expiresAt:now+1800000,token,runner:{id:'runner_isso',appIds:[app]}};
 for(const platforms of [undefined,[],['ios','ios'],['web'],['ios','android','web']])assert.equal(!!validAdmission({...base,platforms},app,sha,now),false);
 assert.equal(validAdmission({...base,platforms:['android','ios']},app,sha,now),true);
});
test('both admitted platforms succeed despite bounded empty webhook ordering',async()=>{
 const {runAdmittedPlatforms}=await import('./github-runner-bootstrap.mjs');const calls=[],waits=[];
 const results=await runAdmittedPlatforms(['android','ios'],{runOnce:async platform=>{calls.push(platform);return calls.length===1?{state:'empty'}:{state:'succeeded',platform,jobId:'job_'+platform,deploymentId:'deploy_'+platform};},wait:async()=>{waits.push(1);}});
 assert.deepEqual(calls,['android','android','ios']);assert.equal(waits.length,1);assert.deepEqual(results.map(r=>r.platform),['android','ios']);
});
test('an ordinary first-platform export failure preserves a successful sibling and fails the workflow',async()=>{
 const {runAdmittedPlatforms}=await import('./github-runner-bootstrap.mjs');const calls=[];
 await assert.rejects(runAdmittedPlatforms(['ios','android'],{runOnce:async platform=>{calls.push(platform);return platform==='ios'?{state:'failed',platform,jobId:'job_ios',code:'EXPORT_FAILED'}:{state:'succeeded',platform,jobId:'job_android',deploymentId:'deploy_android'};}}),error=>error.message==='PLATFORM_DEPLOYMENTS_INCOMPLETE'&&error.outcomes[1].state==='succeeded');
 assert.deepEqual(calls,['ios','android']);
});
test('not-ready target is bounded and does not prevent a sibling deployment',async()=>{
 const {runAdmittedPlatforms}=await import('./github-runner-bootstrap.mjs');const calls=[];
 await assert.rejects(runAdmittedPlatforms(['android','ios'],{maxAttempts:2,wait:async()=>{},runOnce:async platform=>{calls.push(platform);return platform==='android'?{state:'empty'}:{state:'succeeded',platform,jobId:'job_ios',deploymentId:'deploy_ios'};}}),error=>error.outcomes[0].code==='WEBHOOK_JOB_NOT_READY'&&error.outcomes[1].state==='succeeded');
 assert.deepEqual(calls,['android','android','ios']);
});
test('wrong platform, malformed success and fatal uncertainty never become successful or retried',async()=>{
 const {runAdmittedPlatforms}=await import('./github-runner-bootstrap.mjs');
 for(const result of [{state:'succeeded',platform:'android',jobId:'job',deploymentId:'dep'},{state:'succeeded',platform:'ios',jobId:'job'},{state:'publication_unknown',platform:'ios',jobId:'job'}]){let calls=0;await assert.rejects(runAdmittedPlatforms(['ios','android'],{runOnce:async()=>{calls++;return result;}}));assert.equal(calls,1);}
 for(const platforms of [[],['ios','ios'],['web'],['ios','android','web']])await assert.rejects(runAdmittedPlatforms(platforms,{runOnce:async()=>{throw Error('must not run');}}),/GITHUB_RUNNER_CONFIGURATION_INVALID/);
});
test('a second-target failure keeps the already successful target and authentication transport errors are not retried',async()=>{
 const {runAdmittedPlatforms}=await import('./github-runner-bootstrap.mjs');const delivered=[];
 await assert.rejects(runAdmittedPlatforms(['android','ios'],{runOnce:async platform=>platform==='android'?{state:'succeeded',platform,jobId:'job_android',deploymentId:'deploy_android'}:{state:'failed',platform,jobId:'job_ios',code:'SOURCE_UNAVAILABLE'},onOutcome:value=>delivered.push(value)}),error=>error.outcomes[0].state==='succeeded'&&error.outcomes[1].state==='failed');
 assert.deepEqual(delivered.map(value=>value.platform),['android','ios']);
 let calls=0;await assert.rejects(runAdmittedPlatforms(['ios','android'],{runOnce:async()=>{calls++;throw new Error('RUNNER_REVOKED');}}),/RUNNER_REVOKED/);assert.equal(calls,1);
});
