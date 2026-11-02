#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateDirectory } from './private-paths.mjs';
import { startBuildConsole } from './build-console-server.mjs';
export async function runBuildConsole(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: 'node scripts/artifacts/build-console.mjs --state-dir /PRIVATE/STATE --apps app-a,app-b [--port 0]' };
  if (argv.length > 6 || argv.length % 2) throw new Error('BUILD_ARGUMENT_INVALID');
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--state-dir', '--apps', '--port'].includes(argv[i]) || Object.hasOwn(args, argv[i]) || !argv[i + 1] || argv[i + 1].length > 4096) throw new Error('BUILD_ARGUMENT_INVALID');
    args[argv[i]] = argv[i + 1];
  }
  const directory = await privateDirectory(args['--state-dir']), appIds = (args['--apps'] ?? '').split(',');
  if (args['--port'] && !/^\d{1,5}$/.test(args['--port'])) throw new Error('BUILD_ARGUMENT_INVALID');
  const code = randomBytes(24).toString('hex'), approvalFile = join(directory, '.console-approval-' + randomBytes(8).toString('hex') + '.txt');
  let server, handle;
  try {
    handle = await open(approvalFile, 'wx', 0o600); await handle.writeFile(code + '\n'); await handle.sync(); await handle.close(); handle = null;
    server = await startBuildConsole({ directory, appIds, port: Number(args['--port'] ?? 0), approvalCode: code });
  } catch (error) { await handle?.close(); await rm(approvalFile, { force: true }); throw error; }
  let closed = false;
  return { origin: server.origin, approvalFile, mode: 'loopback-owner-only', async close() {
    if (closed) return; closed = true; try { await server.close(); } finally { await rm(approvalFile, { force: true }); }
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runBuildConsole(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result, (key, value) => typeof value === 'function' ? undefined : value) + '\n');
    if (result.close) for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      result.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
    });
  } catch (error) { process.stderr.write((/^(BUILD|ARTIFACT)_[A-Z_]+$/.test(error.message) ? error.message : 'BUILD_CONSOLE_START_FAILED') + '\n'); process.exitCode = 1; }
}
