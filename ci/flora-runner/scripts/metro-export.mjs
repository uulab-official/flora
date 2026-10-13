import {createRequire} from "node:module";
import {mkdir,readFile,writeFile,realpath} from "node:fs/promises";
import {join,resolve,sep,dirname} from "node:path";
import {createHash} from "node:crypto";
const [inputRoot,entry,platform,out]=process.argv.slice(2);
if(!inputRoot||!entry||!["ios","android"].includes(platform)||!out)throw new Error("Invalid fixed export invocation");
const root=await realpath(inputRoot);
const require=createRequire(join(root,"package.json")), Metro=require("metro");
const config=await Metro.loadConfig({cwd:root});config.projectRoot=root;config.maxWorkers=2;config.useWatchman=false;const metroRequire=createRequire(require.resolve("metro/package.json")),moduleSystem=metroRequire.resolve("metro-runtime/src/polyfills/require.js");config.transformer.asyncRequireModulePath=metroRequire.resolve("metro-runtime/src/modules/asyncRequire.js");config.watchFolders=[...new Set([...(config.watchFolders??[]),dirname(dirname(moduleSystem))])];config.reporter={update(){}};
await mkdir(join(out,"assets"),{recursive:true});
const result=await Metro.runBuild(config,{entry,platform,dev:false,minify:true,assets:true,bundleOut:join(out,"launch.bundle"),sourceMap:false});
const assets=[],keys=new Map(),boundary=await realpath(root);
for(const asset of result.assets??[]){
 if(!Array.isArray(asset.files)||asset.files.length>16||typeof asset.hash!=="string")throw new Error("Unsupported Metro asset metadata");
 for(let i=0;i<asset.files.length;i++){
  const path=await realpath(asset.files[i]);if(!path.startsWith(boundary+sep))throw new Error("Asset outside project root");
  const bytes=await readFile(path),key=asset.fileHashes?.[i]??(asset.files.length===1?asset.hash:asset.hash+"_"+(asset.scales?.[i]??i));
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(key))throw new Error("Unsupported Metro asset key");
  const digest=createHash("sha256").update(bytes).digest("hex");if(keys.has(key)){if(keys.get(key)!==digest)throw new Error("Conflicting asset key");continue;}keys.set(key,digest);
  await writeFile(join(out,"assets",key),bytes,{flag:"wx"});assets.push({path:"assets/"+key,key,ext:asset.type});
 }
}
await writeFile(join(out,"metadata.json"),JSON.stringify({version:0,bundler:"metro",fileMetadata:{[platform]:{bundle:"launch.bundle",assets}}}));
