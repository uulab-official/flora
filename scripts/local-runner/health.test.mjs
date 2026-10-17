import test from 'node:test';
import assert from 'node:assert/strict';
import {checkHealth,minimumFreeBytes,dockerAvailable} from './health.mjs';
const c={runtimeDirectory:'/private/runtime'};
const signal=()=>new AbortController().signal;
test('host runtime and scratch filesystems must have 2GiB available before Docker probe',async()=>{const paths=[];let probes=0;assert.deepEqual(await checkHealth(c,{signal:signal(),filesystem:async(path,options)=>{paths.push(path);assert.deepEqual(options,{bigint:true});return {bavail:minimumFreeBytes,bsize:1n};},docker:async()=>{probes++;return true;}}),{ok:true});assert.deepEqual(paths,['/private/runtime','/private/runtime/scratch']);assert.equal(probes,1);});
test('low disk or unavailable/invalid filesystem prohibits Docker spawn and never retains errors',async()=>{for(const filesystem of [async()=>({bavail:minimumFreeBytes-1n,bsize:1n}),async()=>{throw Error('secret-path');},async()=>({bavail:Infinity,bsize:1}),async()=>({bavail:-1n,bsize:1n})]){let spawns=0;const r=await checkHealth(c,{signal:signal(),filesystem,docker:async()=>{spawns++;return true;}});assert.equal(r.ok,false);assert.ok(['DISK_SPACE_LOW','DISK_SPACE_UNAVAILABLE'].includes(r.code));assert.equal(spawns,0);assert.ok(!JSON.stringify(r).includes('secret'));}});
test('scratch separately checked even when private journal filesystem has space',async()=>{let checks=0;assert.deepEqual(await checkHealth(c,{signal:signal(),filesystem:async()=>({bavail:++checks===1?minimumFreeBytes:0n,bsize:1n}),docker:async()=>assert.fail('no spawn')}),{ok:false,code:'DISK_SPACE_LOW'});});
test('Docker unavailability or exception fails closed',async()=>{for(const docker of [async()=>false,async()=>{throw Error('secret-socket');}])assert.deepEqual(await checkHealth(c,{signal:signal(),filesystem:async()=>({bavail:minimumFreeBytes,bsize:1n}),docker}),{ok:false,code:'ISOLATION_UNAVAILABLE'});});
test('aborted probe does not spawn Docker',async()=>{const controller=new AbortController();controller.abort();assert.equal(await dockerAvailable({},controller.signal),false);});
test('Docker probe uses fixed read-only argv, ignores all output and kills on bounded timeout',async()=>{
 const {EventEmitter}=await import('node:events');const env={DOCKER_HOST:'unix:///private/socket',PATH:'/trusted/bin'};let killed=0;
 const spawnProcess=(command,args,options)=>{assert.equal(command,'docker');assert.deepEqual(args,['info','--format','{{.ServerVersion}}']);assert.deepEqual(options,{env,stdio:'ignore'});const child=new EventEmitter();child.kill=signal=>{assert.equal(signal,'SIGKILL');killed++;queueMicrotask(()=>child.emit('close',0));};return child;};
 assert.equal(await dockerAvailable(env,signal(),{timeoutMs:5,spawnProcess}),false);assert.equal(killed,1);
});
test('timeout settles false without close, even if kill throws; late events safely clean child handlers',async()=>{
 const {EventEmitter,getEventListeners}=await import('node:events');
 for(const throws of [false,true]){const controller=new AbortController(),child=new EventEmitter();let killed=0,unref=0;
 child.kill=()=>{killed++;if(throws)throw Error('private-error');};child.unref=()=>{unref++;};
 const result=await Promise.race([dockerAvailable({},controller.signal,{timeoutMs:5,spawnProcess:()=>child}),new Promise(resolve=>setTimeout(()=>resolve('hung'),100))]);
 assert.equal(result,false);assert.equal(killed,1);assert.equal(unref,1);assert.equal(getEventListeners(controller.signal,'abort').length,0);
 child.emit('error',Error('late secret'));child.emit('close',0);assert.equal(child.listenerCount('error'),0);assert.equal(child.listenerCount('close'),0);
 }
});
test('abort settles immediately, kill synchronous/microtask close cannot report success, deadline cleared',async()=>{
 const {EventEmitter,getEventListeners}=await import('node:events');
 for(const timing of ['none','sync','microtask']){const controller=new AbortController(),child=new EventEmitter();let killed=0;
 child.kill=()=>{killed++;if(timing==='sync')child.emit('close',0);if(timing==='microtask')queueMicrotask(()=>child.emit('close',0));};child.unref=()=>{};
 const promise=dockerAvailable({},controller.signal,{timeoutMs:10,spawnProcess:()=>child});controller.abort();assert.equal(await promise,false);
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(killed,1);assert.equal(getEventListeners(controller.signal,'abort').length,0);
 if(timing==='none'){child.emit('error',Error('late'));child.emit('close',0);}assert.equal(child.listenerCount('error'),0);assert.equal(child.listenerCount('close'),0);
 }
});
