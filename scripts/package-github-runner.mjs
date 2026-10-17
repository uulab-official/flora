import {createRequire} from 'node:module';
import {mkdir, readFile, writeFile, copyFile, readdir, stat} from 'node:fs/promises';
import {resolve, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildPnpmHelper} from '../packages/ota-runner/scripts/pnpm-helper-build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(process.argv[2] ?? '');
if (process.argv.length !== 3 || destination === root || !destination.endsWith('/ci/flora-runner')) throw new Error('EXPLICIT_DISTRIBUTION_DIRECTORY_REQUIRED');
const {build} = createRequire(join(root, 'packages/cloudflare/package.json'))('esbuild');
await mkdir(join(destination, 'dist'), {recursive:true});
const alias=Object.fromEntries(['core','config','dogfood'].map(name=>['@app-ops/'+name,join(root,'packages',name,'src/index.ts')]));
const bundled = await build({absWorkingDir:root, entryPoints:['packages/ota-runner/src/main.ts'], outfile:join(destination,'dist/main.js'), bundle:true, platform:'node', format:'esm', target:'node24', metafile:true,alias,external:['./pnpm-dependencies.js']});
const inputs = Object.keys(bundled.metafile.inputs).sort();
for (const input of inputs) {
  if (!/^packages\/(?:ota-runner|core|config|dogfood)\/src\/[a-zA-Z0-9_./-]+\.ts$/.test(input)) throw new Error('UNEXPECTED_DISTRIBUTION_INPUT');
  const target = join(destination,'source',input); await mkdir(resolve(target,'..'),{recursive:true}); await copyFile(join(root,input),target);
}
for (const helper of ['artifacts','process','expo','inside-container','dependencies','prepare-cache-container']) {
  await copyFile(join(root,`packages/ota-runner/dist/${helper}.js`),join(destination,`dist/${helper}.js`));
  await copyFile(join(root,`packages/ota-runner/src/${helper}.ts`),join(destination,`source/packages/ota-runner/src/${helper}.ts`));
}
await buildPnpmHelper({runnerRoot:join(root,'packages/ota-runner'),destinationDirectory:join(destination,'dist')});
await mkdir(join(destination,'source/packages/ota-runner/scripts'),{recursive:true});
for(const file of ['pnpm-helper-build.mjs','bundle-pnpm-helper.mjs'])await copyFile(join(root,'packages/ota-runner/scripts',file),join(destination,'source/packages/ota-runner/scripts',file));
await copyFile(join(root,'packages/ota-runner/src/pnpm-dependencies.ts'),join(destination,'source/packages/ota-runner/src/pnpm-dependencies.ts'));
await mkdir(join(destination,'scripts'),{recursive:true});
await copyFile(join(root,'packages/ota-runner/scripts/metro-export.mjs'),join(destination,'scripts/metro-export.mjs'));
await copyFile(join(root,'scripts/github-runner-bootstrap.mjs'),join(destination,'github-runner-bootstrap.mjs'));
await copyFile(join(root,'scripts/github-runner-bootstrap.test.mjs'),join(destination,'github-runner-bootstrap.test.mjs'));
await copyFile(join(root,'scripts/github-runner.Dockerfile'),join(destination,'Dockerfile'));
await copyFile(join(root,'scripts/pc-pnpm-runner.Dockerfile'),join(destination,'pnpm.Dockerfile'));
await copyFile(join(root,'scripts/pc-pnpm-arm64-runner.Dockerfile'),join(destination,'pnpm-arm64.Dockerfile'));
await writeFile(join(destination,'.dockerignore'),'**\n!Dockerfile\n!pnpm.Dockerfile\n!pnpm-arm64.Dockerfile\n!.dockerignore\n');
await writeFile(join(destination,'.gitignore'),'!dist/\n!dist/*.js\n!dist/pnpm-yaml.LICENSE\n');
await copyFile(join(root,'LICENSE'),join(destination,'LICENSE'));
await writeFile(join(destination,'package.json'),JSON.stringify({name:'flora-github-runner',private:true,type:'module',license:'Apache-2.0'},null,2)+'\n');
await writeFile(join(destination,'README.md'),`# Flora trusted GitHub source Runner\n\nThis distribution is built from the included TypeScript source snapshot. Each file is recorded in SHA256SUMS. App code is downloaded separately at the server-admitted commit and runs only in an isolated Docker compiler. A PC service can run this bundle with app-scoped Runner credentials; GitHub Actions and EAS are not required.\n\nNode 24.19.0; npm 10.9.8 or the optional pinned pnpm 11.10.0 compiler image; own Flora OTA engine. Dependency preparation disables lifecycle scripts and accepts verified npm registry SHA512 entries and vendored SDK archives. The compiler has no network or publication credentials. The standalone pnpm YAML helper includes its license. PC power, networking and hosting usage still apply. The reusable GitHub Actions workflow is a separate opt-in path with GitHub billing.\n\nBuild command in the Flora workspace: node scripts/package-github-runner.mjs /absolute/controller-worktree/ci/flora-runner\n`);
async function walk(directory){let result=[];for(const item of await readdir(directory)){const file=join(directory,item);if((await stat(file)).isDirectory())result.push(...await walk(file));else result.push(file);}return result;}
const hashes=[];for(const file of (await walk(destination)).sort()){if(file===join(destination,'SHA256SUMS'))continue;hashes.push(createHash('sha256').update(await readFile(file)).digest('hex')+'  '+relative(destination,file));}
await writeFile(join(destination,'SHA256SUMS'),hashes.join('\n')+'\n');
process.stdout.write(JSON.stringify({files:hashes.length,sourceInputs:inputs.length,destination})+'\n');
