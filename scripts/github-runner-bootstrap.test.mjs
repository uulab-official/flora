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
test('platform private config permits the engine nonrecursive recovery mkdir under a fresh private root',async t=>{
 const {mkdtemp,mkdir,writeFile,stat,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{platformRunnerConfig}=await import('./github-runner-bootstrap.mjs');
 const root=await mkdtemp(join(tmpdir(),'flora-bootstrap-regression-'));t.after(()=>rm(root,{recursive:true,force:true}));const targets=[];
 for(const platform of ['ios','android']){
  const config=platformRunnerConfig(root,platform,{origin:'https://flora.example.test',token:'runner_fixture.'+'a'.repeat(43),dockerImage:'sha256:'+'b'.repeat(64)});targets.push(config.recoveryDirectory);
  // Same nonrecursive operation as recovery.privateDirectory: parent must already exist.
  await mkdir(config.recoveryDirectory,{mode:0o700});assert.equal((await stat(config.recoveryDirectory)).mode&0o777,0o700);
  const path=join(root,'runner-'+platform+'.json');await writeFile(path,JSON.stringify(config),{mode:0o600});assert.equal((await stat(path)).mode&0o777,0o600);assert.equal(config.claimPlatform,platform);
 }
 assert.equal(new Set(targets).size,2);assert.equal((await stat(root)).mode&0o777,0o700);
});
test('initialization failure forwards only an exact allowlisted CLI code without stderr material',async()=>{
 const {initializationDiagnostic}=await import('./github-runner-bootstrap.mjs');assert.deepEqual(initializationDiagnostic('RECOVERY_JOURNAL_UNAVAILABLE\n'),{diagnostic:true,stage:'runner-initialization',code:'RECOVERY_JOURNAL_UNAVAILABLE'});
 for(const stderr of ['Bearer credential','MY_SECRET_TOKEN','RECOVERY_JOURNAL_UNAVAILABLE\nBearer credential','SECRET\nRUNNER_STOPPED',null])assert.equal(initializationDiagnostic(stderr),null);
});
test('execution failures forward exact typed CLI codes while excluding arbitrary stderr',async()=>{
 const {initializationDiagnostic}=await import('./github-runner-bootstrap.mjs');
 for(const code of ['BUSY','LEASE_STALE','CONFIG_CONFLICT','CI_SESSION_REJECTED','INVALID_INPUT','PERMISSION_DENIED','RUNNER_TRANSPORT_UNAVAILABLE','IDEMPOTENCY_CONFLICT','INVALID_TRANSITION'])assert.deepEqual(initializationDiagnostic(code+'\n'),{diagnostic:true,stage:'runner-execution',code});
 for(const stderr of ['PRIVATE_BEARER_CREDENTIAL','BUSY\nBearer private-token','token=secret\nLEASE_STALE'])assert.equal(initializationDiagnostic(stderr),null);
});
test('safe diagnostics retain only a bounded numeric HTTP status',()=>{
 for(const httpStatus of [0,400,409,503])assert.deepEqual(safeDiagnostic({diagnostic:true,stage:'asset-upload',code:'BUSY',httpStatus,token:'private'}),{diagnostic:true,stage:'asset-upload',code:'BUSY',httpStatus});
 for(const httpStatus of [-1,99,600,409.5,'409','Bearer credential'])assert.equal(safeDiagnostic({diagnostic:true,stage:'asset-upload',code:'BUSY',httpStatus}),null);
});
test('actual CLI initializes separate remote recovery directories before empty platform claims',async t=>{
 const {mkdtemp,writeFile,stat,rm,access}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{fileURLToPath}=await import('node:url'),{createServer}=await import('node:http'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{platformRunnerConfig}=await import('./github-runner-bootstrap.mjs');
 // Same test runs in source and the hash-verified packaged controller.
 const candidates=[new URL('../packages/ota-runner/dist/main.js',import.meta.url),new URL('./dist/main.js',import.meta.url)];let main;
 for(const candidate of candidates){try{await access(candidate);main=fileURLToPath(candidate);break;}catch{}}
 assert.ok(main,'compiled trusted Runner required for smoke test');
 const root=await mkdtemp(join(tmpdir(),'flora-bootstrap-cli-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'docker'),'#!/bin/sh\nexit 0\n',{mode:0o700});const claims=[];
 const server=createServer(async(req,res)=>{let input='';for await(const chunk of req)input+=chunk;
  if(req.url==='/api/runner/checkpoint-list'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({checkpoints:[]}));return;}
  assert.equal(req.url,'/api/runner/claim');claims.push(JSON.parse(input));res.writeHead(204);res.end();
 });await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>{server.close(done);server.closeAllConnections();}));
 const origin='http://127.0.0.1:'+server.address().port;
 for(const platform of ['ios','android']){
  const config=platformRunnerConfig(root,platform,{origin,token:'runner_fixture.'+'a'.repeat(43),dockerImage:'sha256:'+'b'.repeat(64)}),path=join(root,'runner-'+platform+'.json');await writeFile(path,JSON.stringify(config),{mode:0o600});
  const output=await promisify(execFile)(process.execPath,[main,'--config',path,'--once'],{env:{PATH:root},timeout:5000});assert.equal(output.stderr,'');assert.deepEqual(JSON.parse(output.stdout),{state:'empty'});assert.equal((await stat(config.recoveryDirectory)).mode&0o777,0o700);
 }
 assert.deepEqual(claims,[{platform:'ios'},{platform:'android'}]);
});
test('actual CLI never prints arbitrary HTTP error text while retaining its typed failure status',async t=>{
 const {mkdtemp,writeFile,rm,access}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{fileURLToPath}=await import('node:url'),{createServer}=await import('node:http'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{platformRunnerConfig,initializationDiagnostic}=await import('./github-runner-bootstrap.mjs');
 const candidates=[new URL('../packages/ota-runner/dist/main.js',import.meta.url),new URL('./dist/main.js',import.meta.url)];let main;for(const candidate of candidates){try{await access(candidate);main=fileURLToPath(candidate);break;}catch{}}assert.ok(main);
 const root=await mkdtemp(join(tmpdir(),'flora-bootstrap-denied-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'docker'),'#!/bin/sh\nexit 0\n',{mode:0o700});
 const server=createServer(async(req,res)=>{for await(const _chunk of req){}res.writeHead(req.url==='/api/runner/checkpoint-list'?200:403,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url==='/api/runner/checkpoint-list'?{checkpoints:[]}:{error:'PRIVATE_BEARER_CREDENTIAL'}));});await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>{server.close(done);server.closeAllConnections();}));
 const config=platformRunnerConfig(root,'ios',{origin:'http://127.0.0.1:'+server.address().port,token:'runner_fixture.'+'a'.repeat(43),dockerImage:'sha256:'+'b'.repeat(64)}),path=join(root,'runner-ios.json');await writeFile(path,JSON.stringify(config),{mode:0o600});
 await assert.rejects(promisify(execFile)(process.execPath,[main,'--config',path,'--once'],{env:{PATH:root},timeout:5000}),error=>{
  assert.equal(error.code,1);assert.equal(error.stderr,'RUNNER_REQUEST_REJECTED\n');assert.ok(!error.stdout.includes('PRIVATE_BEARER_CREDENTIAL'));
  const diagnostics=error.stdout.trim().split('\n').map(line=>JSON.parse(line));assert.ok(diagnostics.some(value=>value.stage==='claim'&&value.httpStatus===403&&value.code==='RUNNER_REQUEST_REJECTED'));
  assert.equal(initializationDiagnostic(error.stderr).code,'RUNNER_REQUEST_REJECTED');return true;
 });
});
