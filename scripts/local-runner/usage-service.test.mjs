import test from 'node:test';import assert from 'node:assert/strict';import {usagePlist} from './usage-service.mjs';
test('usage collector auto-start keeps provider authentication out of plist and isolates OTA service',()=>{
 const value={nodePath:'/tools/node',collectorPath:'/private/bin/usage.mjs',runtimeDirectory:'/private',wranglerPath:'/flora/wrangler.js',home:'/home/operator',path:'/tools:/usr/bin:/bin'};
 const xml=usagePlist(value);assert.match(xml,/<key>RunAtLoad<\/key><true\/>/);assert.match(xml,/kr\.co\.uulab\.flora-usage/);assert.doesNotMatch(xml,/flora-runner<|TOKEN|PASSWORD|KEYS/);assert.match(xml,/CLOUDFLARE_AUTH_USE_KEYRING/);assert.match(xml,/SuccessfulExit/);
 assert.throws(()=>usagePlist({...value,wranglerPath:'https://attacker.invalid'}));assert.throws(()=>usagePlist({...value,path:'/bin\ninject'}));
});
