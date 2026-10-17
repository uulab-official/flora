import test from'node:test';import assert from'node:assert/strict';import{aggregateUsage,budgetQuery,collectUsage,parseArguments,providerUrl,reportUrl,accountId,credentialEnvironment}from'./usage-collector.mjs';
const now=Date.UTC(2026,9,15,1),day='2026-10-15',data=(groups)=>({data:{viewer:{accounts:[{d1AnalyticsAdaptiveGroups:groups}]}}}),group=(read,write)=>({dimensions:{date:day},sum:{rowsRead:read,rowsWritten:write}});
test('official credential CLI diagnostics cannot persist unencrypted authentication JSON',()=>{const env=credentialEnvironment();assert.equal(env.WRANGLER_WRITE_LOGS,'false');assert.equal(env.CLOUDFLARE_AUTH_USE_KEYRING,'true');assert.equal(env.WRANGLER_LOG,undefined);assert.equal(env.CLOUDFLARE_API_TOKEN,undefined);});
test('account usage aggregates real daily measurements and rejects absent/error/wrongday/unsafe metrics without zero invention',()=>{
 assert.deepEqual(aggregateUsage(data([group(12,3),group(5,2)]),day,now),{day,observedAt:now,rowsRead:17,rowsWritten:5});
 assert.equal(budgetQuery(day).variables.account,accountId);assert.doesNotMatch(budgetQuery(day).query,/databaseId/);
 for(const value of [{},{errors:[{}],...data([group(1,1)])},data([]),data([group(null,1)]),data([group(-1,1)]),data([group(0.5,1)]),data([{...group(1,1),dimensions:{date:'2026-10-14'}}]),data([group(Number.MAX_SAFE_INTEGER,1),group(1,1)])])assert.throws(()=>aggregateUsage(value,day,now));
});
test('provider credential only goes to Cloudflare and protected Runner credential only posts scalar metrics to Flora',async()=>{
 const calls=[];const result=await collectUsage({runtimeDirectory:'/private',nodePath:'/node',wranglerPath:'/wrangler'},{runnerToken:async()=> 'privateRunner',credential:async()=> 'privateProvider',now:()=>now,post:async(url,token,body)=>{calls.push({url,token,body});return url===providerUrl?{status:200,body:data([group(42,7)])}:{status:200,body:{recorded:true}};}});
 assert.equal(result.rowsRead,42);assert.equal(calls[0].token,'privateProvider');assert.equal(calls[1].token,'privateRunner');assert.equal(calls[1].url,reportUrl);assert.deepEqual(Object.keys(calls[1].body).sort(),['day','observedAt','rowsRead','rowsWritten']);assert.doesNotMatch(JSON.stringify(result),/privateProvider|privateRunner/);
});
test('failed provider reads or UTC rollover never publish a synthetic report',async()=>{
 for(const mode of['error','empty','rollover']){let calls=0,times=0;await assert.rejects(collectUsage({},{runnerToken:async()=> 'runner',credential:async()=> 'provider',now:()=>now+(mode==='rollover'&&times++>0?86400000:0),post:async()=>{calls++;return mode==='error'?{status:403,body:{}}:{status:200,body:data(mode==='empty'?[]:[group(1,1)])};}}));assert.equal(calls,1);}
 assert.throws(()=>parseArguments(['--url','https://attacker.invalid']));assert.throws(()=>parseArguments(['--node-path','/node']));
});
