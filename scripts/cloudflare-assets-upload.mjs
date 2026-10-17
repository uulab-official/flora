/** Upload only a granted Workers static-assets bucket. The short-lived asset
 * token is read from stdin, kept in memory, and never written to disk. */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { HOSTED_ASSETS } from './build-cloudflare.mjs';

const require = createRequire(resolve('packages/cloudflare/package.json'));
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { hash } = wranglerRequire('blake3-wasm');
const directory = resolve('packages/cloudflare/dist/hosted/public');
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const files = await Promise.all(HOSTED_ASSETS.map(async name => {
  const bytes = await readFile(resolve(directory, name));
  return { name, bytes, hash: hash(bytes.toString('base64') + extname(name).slice(1)).toString('hex').slice(0, 32) };
}));
if (process.argv[2] === 'manifest') {
  console.log(JSON.stringify(Object.fromEntries(files.map(file => ['/' + file.name, { hash: file.hash, size: file.bytes.length }]))));
} else if (process.argv[2] === 'upload') {
  let line = '';
  for await (const chunk of process.stdin) {
    line += chunk;
    if (line.length > 65_536) throw new Error('INPUT_LIMIT');
    if (line.includes('\n')) break;
  }
  const { accountId, jwt, buckets } = JSON.parse(line);
  if (!/^[a-f0-9]{32}$/.test(accountId) || typeof jwt !== 'string' || !Array.isArray(buckets)) throw new Error('INVALID_UPLOAD_GRANT');
  let completion = buckets.length === 0 ? jwt : null;
  for (const bucket of buckets) {
    const form = new FormData();
    for (const digest of bucket) {
      const file = files.find(item => item.hash === digest);
      if (!file) throw new Error('UNKNOWN_ASSET');
      form.append(digest, new Blob([file.bytes.toString('base64')], { type: types[extname(file.name)] }), digest);
    }
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/assets/upload?base64=true`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + jwt }, body: form, signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    if (!response.ok || result.success !== true) throw new Error('ASSET_UPLOAD_REJECTED');
    if (result.result?.jwt) completion = result.result.jwt;
  }
  if (!completion) throw new Error('COMPLETION_GRANT_MISSING');
  // Private orchestrator transport: callers must consume this result without
  // displaying the token or persisting it in a deployment config.
  process.stdout.write(JSON.stringify({ jwt: completion }) + '\n');
} else throw new Error('Usage: cloudflare-assets-upload.mjs manifest|upload');
