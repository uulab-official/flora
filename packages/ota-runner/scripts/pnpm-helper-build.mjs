// Shared trusted build recipe. Neither packaging nor the runner build consumes
// the possibly unbundled helper left in dist by a direct tsc invocation.
import {createRequire,isBuiltin} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';

export async function buildPnpmHelper({runnerRoot=fileURLToPath(new URL('../',import.meta.url)),destinationDirectory=join(runnerRoot,'dist')}={}){
 const manifest=JSON.parse(await readFile(join(runnerRoot,'package.json'),'utf8'));
 const require=createRequire(join(runnerRoot,'package.json')),yamlRoot=dirname(require.resolve('yaml/package.json')),yamlManifest=JSON.parse(await readFile(join(yamlRoot,'package.json'),'utf8'));
 if(manifest.dependencies?.yaml!=='2.9.1'||yamlManifest.version!=='2.9.1')throw Error('PINNED_YAML_REQUIRED');
 const {build}=createRequire(join(runnerRoot,'../cloudflare/package.json'))('esbuild');
 const result=await build({absWorkingDir:runnerRoot,entryPoints:[join(runnerRoot,'src/pnpm-dependencies.ts')],outfile:join(destinationDirectory,'pnpm-dependencies.js'),bundle:true,alias:{yaml:join(yamlRoot,'browser/index.js')},platform:'node',format:'esm',target:'node24',metafile:true,write:false});
 for(const output of Object.values(result.metafile.outputs))for(const dependency of output.imports)if(dependency.external&&!isBuiltin(dependency.path))throw Error('PNPM_HELPER_NOT_STANDALONE');
 if(result.outputFiles.length!==1)throw Error('PNPM_HELPER_NOT_STANDALONE');
 const license=await readFile(join(yamlRoot,'LICENSE'));if(!license.length)throw Error('YAML_LICENSE_REQUIRED');
 await mkdir(destinationDirectory,{recursive:true});await writeFile(join(destinationDirectory,'pnpm-dependencies.js'),result.outputFiles[0].contents);await writeFile(join(destinationDirectory,'pnpm-yaml.LICENSE'),license);
}
