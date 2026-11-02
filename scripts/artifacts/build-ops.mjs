#!/usr/bin/env node
import { inspectLocalBuild } from './local-build-preflight.mjs';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openLocalBuildService } from './local-build-service.mjs';
import { backupLocalBuildState, verifyLocalBuildBackup, restoreLocalBuildState } from './local-build-backup.mjs';

const commands = {
  evidence: { required: ['app', 'job', 'artifact'], optional: [] },
  preflight: { required: ['app', 'job', 'recipe', 'expected-version'], optional: [] },
  init: { required: [], optional: [] },
  create: { required: ['input'], optional: [] },
  transition: { required: ['input'], optional: [] },
  retry: { required: ['input'], optional: [] },
  overview: { required: ['app'], optional: [] },
  complete: { required: ['input'], optional: [] },
  list: { required: ['app'], optional: ['limit', 'after-job'] },
  show: { required: ['app', 'job'], optional: [] },
  history: { required: ['app', 'job'], optional: ['limit', 'after-sequence'] },
  export: { required: ['app', 'job', 'artifact', 'output'], optional: [] },
  doctor: { required: [], optional: ['app', 'max-bytes', 'max-entries'] },
  backup: { required: ['output'], optional: ['max-bytes', 'max-entries'] },
  'verify-backup': { required: ['backup'], optional: ['max-bytes', 'max-entries'] },
  restore: { required: ['backup'], optional: ['max-bytes', 'max-entries'] },
};
function parse(argv) {
  if (argv.length > 40 || argv.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')))
    throw new Error('BUILD_ARGUMENT_INVALID');
  const [command, ...args] = argv;
  if (!Object.hasOwn(commands, command ?? '') || args.length % 2 !== 0) throw new Error('BUILD_ARGUMENT_INVALID');
  const common = command === 'verify-backup' ? [] : ['state-dir'];
  const spec = commands[command], allowed = new Set([...common, ...spec.required, ...spec.optional]), options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].startsWith('--') ? args[index].slice(2) : '';
    if (!allowed.has(key) || Object.hasOwn(options, key) || args[index + 1] === '' || args[index + 1].startsWith('--'))
      throw new Error('BUILD_ARGUMENT_INVALID');
    options[key] = args[index + 1];
  }
  for (const key of [...common, ...spec.required]) if (!Object.hasOwn(options, key)) throw new Error('BUILD_ARGUMENT_INVALID');
  return { command, options };
}
function integer(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d{1,12}$/.test(value) || /\s/.test(value)) throw new Error('BUILD_ARGUMENT_INVALID');
  const result = Number(value); if (!Number.isSafeInteger(result)) throw new Error('BUILD_ARGUMENT_INVALID'); return result;
}
export async function readBuildInput(path, { privateOnly = false } = {}) {
  const max = 65536; path = resolve(path);
  if (await realpath(dirname(path)) !== dirname(path)) throw new Error('BUILD_INPUT_UNSAFE');
  const before = await lstat(path, { bigint: true });
  if (privateOnly && ((before.mode & 0o077n) !== 0n || before.uid !== BigInt(process.geteuid()))) throw new Error('BUILD_INPUT_UNSAFE');
  if (!before.isFile() || before.nlink !== 1n) throw new Error('BUILD_INPUT_UNSAFE');
  if (before.size > BigInt(max)) throw new Error('BUILD_INPUT_TOO_LARGE');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await handle.stat({ bigint: true });
    if (!actual.isFile() || ['ino', 'dev', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'mode', 'uid'].some(key => actual[key] !== before[key]))
      throw new Error('BUILD_INPUT_UNSAFE');
    const buffer = Buffer.alloc(max + 1); let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break; size += bytesRead;
    }
    if (size > max) throw new Error('BUILD_INPUT_TOO_LARGE');
    const after = await handle.stat({ bigint: true });
    if (BigInt(size) !== before.size || ['ino', 'dev', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'mode', 'uid'].some(key => after[key] !== before[key]))
      throw new Error('BUILD_INPUT_UNSAFE');
    try {
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
      return result;
    } catch { throw new Error('BUILD_INPUT_INVALID'); }
  } finally { await handle.close(); }
}
export async function runBuildOps(argv) {
  if (argv.length === 1 && ['help', '--help'].includes(argv[0])) return { ok: true, result: {
    usage: 'node scripts/artifacts/build-ops.mjs COMMAND --state-dir /ABSOLUTE/PRIVATE/STATE [OPTIONS]',
    commands, scope: 'local-owner-only; no cloud deployment or installation proof; AAB signing evidence is a separate historical observation' } };
  const { command, options: o } = parse(argv);
  const maintenance = { maxBytes: integer(o['max-bytes'], 1024 * 1024 * 1024), maxEntries: integer(o['max-entries'], 1000) };
  if (command === 'backup') return { ok: true, result: await backupLocalBuildState({ directory: o['state-dir'], target: o.output, ...maintenance }) };
  if (command === 'verify-backup') return { ok: true, result: await verifyLocalBuildBackup({ directory: o.backup, ...maintenance }) };
  if (command === 'restore') return { ok: true, result: await restoreLocalBuildState({ directory: o.backup, target: o['state-dir'], ...maintenance }) };
  if (command === 'preflight') {
    const result = await inspectLocalBuild({ directory: o['state-dir'], scope: { appId: o.app, jobId: o.job },
      recipe: await readBuildInput(o.recipe, { privateOnly: true }), expectedVersion: integer(o['expected-version']) });
    return { ok: result.ready, result };
  }
  let input = o.input ? await readBuildInput(o.input) : undefined;
  // A configured signing verifier is executable operator configuration, not untrusted report data.
  if (command === 'complete' && input?.signaturePolicy !== undefined) input = await readBuildInput(o.input, { privateOnly: true });
  const service = await openLocalBuildService({ directory: o['state-dir'], create: command === 'init' });
  try {
    const scope = { appId: o.app, jobId: o.job }; let result;
    switch (command) {
      case 'init': result = { initialized: true, schemaVersion: 1, storage: 'local-only' }; break;
      case 'create': result = service.create(input); break;
      case 'transition': result = await service.transition(input); break;
      case 'retry': result = await service.retry(input); break;
      case 'overview': result = service.overview({ appId: o.app }); break;
      case 'complete': result = await service.complete(input); break;
      case 'list': result = service.list({ appId: o.app, limit: integer(o.limit, 100), afterJobId: o['after-job'] ?? '' }); break;
      case 'evidence': result = service.evidence({ scope, artifactId: o.artifact }); break;
      case 'show': result = service.show(scope); break;
      case 'history': result = service.history(scope, { limit: integer(o.limit, 100), afterSequence: integer(o['after-sequence'], 0) }); break;
      case 'export': result = await service.export({ scope, artifactId: o.artifact, targetPath: o.output }); break;
      case 'doctor': result = await service.doctor({ appId: o.app, maxBytes: integer(o['max-bytes'], 256 * 1024 * 1024), maxEntries: integer(o['max-entries'], 1000) }); break;
    }
    return { ok: command !== 'doctor' || result.ready, result };
  } finally { service.close(); }
}
async function main() {
  let response;
  try { response = await runBuildOps(process.argv.slice(2)); }
  catch (error) {
    const code = /^(?:BUILD|ARTIFACT)_[A-Z_]{1,80}$/.test(error?.message ?? '') ? error.message
      : error?.code === 'ENOENT' ? 'BUILD_INPUT_UNAVAILABLE' : 'BUILD_OPERATION_FAILED';
    response = { ok: false, error: code };
  }
  process.stdout.write(JSON.stringify(response) + '\n'); process.exitCode = response.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
