const invalid=()=>{throw Error("ONBOARDING_PUBLIC_CONFIG_INVALID");};
function object(value,keys){if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))invalid();return value;}
function text(value,pattern,max=256){if(typeof value!=="string"||new TextEncoder().encode(value).length>max||!pattern.test(value))invalid();return value;}
function origin(value){text(value,/^https:\/\/[^\s]+$/,2048);try{const u=new URL(value);if(u.origin!==value||u.username||u.password||u.port)invalid();return value;}catch{invalid();}}
function appId(value){return text(value,/^[a-z][a-z0-9_-]{2,95}$/,96);}
const version=value=>text(value,/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[A-Za-z0-9.-]{1,16})?$/,32);
export function buildPublicFiles(input,signing){
 const v=object(input,["appId","origin","channel","runtimeVersion","platforms","bundler","entryFile","nodeVersion","packageManager"]);
 object(signing,["appId","keyId","certificate"]);
 const app=appId(v.appId),url=origin(v.origin)+"/updates/"+app;
 if(signing.appId!==app)invalid();
 const keyId=text(signing.keyId,/^[A-Za-z0-9._-]{1,128}$/,128);
 const certificate=text(signing.certificate,/^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----\s*$/,16384);
 const channel=text(v.channel,/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,64),runtimeVersion=text(v.runtimeVersion,/^[^\u0000-\u001f\u007f]+$/,128);
 if(!Array.isArray(v.platforms)||v.platforms.length<1||v.platforms.length>2||new Set(v.platforms).size!==v.platforms.length||v.platforms.some(p=>!["ios","android"].includes(p))||!["metro","expo"].includes(v.bundler))invalid();
 const entryFile=text(v.entryFile,/^[^\\:\u0000-\u001f\u007f]+$/,256);
 if(entryFile.split("/").some(p=>!p||[".","..","__proto__","constructor","prototype"].includes(p)))invalid();
 const manager=object(v.packageManager,["name","version"]);if(!["npm","pnpm","yarn"].includes(manager.name))invalid();
 const config={schemaVersion:1,ota:{runtimeVersion,platforms:[...v.platforms],url},export:{bundler:v.bundler,entryFile,nodeVersion:version(v.nodeVersion),packageManager:{name:manager.name,version:version(manager.version)}}};
 const connection={appId:app,url,channel,runtimeVersion,certificate:certificate.replace(/\r\n/g,"\n").trim()+"\n",keyId};
 return {connection:JSON.stringify(connection,null,2)+"\n",config:JSON.stringify(config,null,2)+"\n"};
}
export function buildRunnerBinding(serverOrigin,currentAppId,runner){
 const app=appId(currentAppId),server=origin(serverOrigin);
 if(!runner||runner.revokedAt!==null||!Array.isArray(runner.appIds)||runner.appIds.length!==1||runner.appIds[0]!==app)invalid();
 const runnerId=text(runner.id,/^runner_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,96);
 return {schemaVersion:1,origin:server,appId:app,runnerId};
}
