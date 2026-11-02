import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openLocalBuildService } from './local-build-service.mjs';
import { isBuildId, isRecord } from './build-lifecycle.mjs';
import { privateDirectory } from './private-paths.mjs';
import { withVerifiedNativeArtifact } from './native-artifact-file.mjs';

const SESSION_MS = 30 * 60_000, APPROVAL_MS = 10 * 60_000, TICKET_MS = 60_000;
const BODY_LIMIT = 16 * 1024, COOKIE = 'flora_local_session';
const digest = value => createHash('sha256').update(value).digest();
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length <= 256 && timingSafeEqual(digest(a), digest(b));
const fail = (status, code) => { const error = new Error(code); error.status = status; throw error; };
function fields(value, allowed) {
  if (!isRecord(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'BUILD_REQUEST_INVALID');
  return value;
}
function query(url, allowed) {
  const output = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(output, key) || value.length > 128) fail(400, 'BUILD_QUERY_INVALID');
    output[key] = value;
  }
  return output;
}
function number(value, fallback, max = 50) {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) fail(400, 'BUILD_QUERY_INVALID');
  return Number(value);
}
function drain(response) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { response.off('drain', done); response.off('close', closed); response.off('error', closed); };
    const done = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error('BUILD_DOWNLOAD_INTERRUPTED')); };
    response.once('drain', done); response.once('close', closed); response.once('error', closed);
    if (response.destroyed) closed(); else if (!response.writableNeedDrain) done();
  });
}
async function body(request, allowForm = false) {
  const type = request.headers['content-type']?.split(';')[0].trim();
  if (!['application/json', ...(allowForm ? ['application/x-www-form-urlencoded'] : [])].includes(type)) fail(415, 'BUILD_CONTENT_TYPE_INVALID');
  if (request.headers['content-encoding']) fail(415, 'BUILD_CONTENT_TYPE_INVALID');
  if (Number(request.headers['content-length'] ?? 0) > BODY_LIMIT) fail(413, 'BUILD_REQUEST_TOO_LARGE');
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > BODY_LIMIT) fail(413, 'BUILD_REQUEST_TOO_LARGE'); chunks.push(chunk); }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (type === 'application/json') return JSON.parse(text);
    const params = new URLSearchParams(text), output = {};
    for (const [key, value] of params) { if (Object.hasOwn(output, key)) throw new Error(); output[key] = value; }
    return output;
  } catch { fail(400, 'BUILD_JSON_INVALID'); }
}
function errorStatus(error) {
  if (error.status) return error.status;
  if (/NOT_FOUND$/.test(error.message)) return 404;
  if (/CONFLICT|ALREADY_EXISTS|TRANSITION_DENIED|COMPLETION_REQUIRED|HASH_MISMATCH|SIZE_MISMATCH|CHANGED|SOURCE_CHANGED/.test(error.message)) return 409;
  if (error.message === 'BUILD_LEDGER_BUSY') return 503;
  return /^(BUILD|ARTIFACT)_.*(INVALID|MISMATCH|REQUIRED)$/.test(error.message) ? 400 : 500;
}
function publicError(error) {
  return /^(BUILD|ARTIFACT)_[A-Z_]{1,80}$/.test(error?.message ?? '') ? error.message : 'BUILD_OPERATION_FAILED';
}
// Local owner only. appIds is an operator-selected capability boundary, not a SaaS tenant model.
export async function startBuildConsole({ directory, appIds, port = 0, approvalCode, now = Date.now }) {
  if (!Array.isArray(appIds) || appIds.length < 1 || appIds.length > 100 || appIds.some(id => !isBuildId(id))
      || new Set(appIds).size !== appIds.length || !Number.isSafeInteger(port) || port < 0 || port > 65535
      || typeof approvalCode !== 'string' || !/^[a-f0-9]{48}$/.test(approvalCode)) throw new Error('BUILD_CONSOLE_CONFIG_INVALID');
  directory = await privateDirectory(directory);
  const service = await openLocalBuildService({ directory });
  const allowed = new Set(appIds), sessions = new Map(), tickets = new Map(), pending = new Set();
  const assets = new Map();
  try {
    for (const [path, file, type] of [['/', 'index.html', 'text/html'], ['/console.mjs', 'console.mjs', 'text/javascript'], ['/console.css', 'console.css', 'text/css']])
      assets.set(path, { bytes: await readFile(new URL('console/' + file, import.meta.url)), type: type + '; charset=utf-8' });
  } catch (error) { service.close(); throw error; }
  let origin, used = false, attempts = 0, activeDownloads = 0, closing = false;
  const approvalExpires = now() + APPROVAL_MS, approvalHash = digest(approvalCode); approvalCode = undefined;
  function scoped(appId, jobId) {
    if (!isBuildId(appId) || (jobId !== undefined && !isBuildId(jobId))) fail(400, 'BUILD_SCOPE_INVALID');
    if (!allowed.has(appId)) fail(403, 'BUILD_APP_FORBIDDEN'); return { appId, jobId };
  }
  function session(request) {
    const cookies = (request.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(COOKIE + '='));
    if (cookies.length !== 1) fail(401, 'BUILD_SESSION_REQUIRED');
    const key = cookies[0].slice(COOKIE.length + 1), item = sessions.get(key);
    if (!item || item.expires <= now()) { sessions.delete(key); fail(401, 'BUILD_SESSION_EXPIRED'); }
    return { key, ...item };
  }
  function prune() {
    for (const [key, item] of tickets) if (item.expires <= now() || !sessions.has(item.sessionKey)) tickets.delete(key);
  }
  function json(response, status, payload) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(payload)); }
  async function handle(request, response) {
    response.setTimeout(30_000, () => response.destroy());
    response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer'); response.setHeader('x-frame-options', 'DENY');
    response.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (closing) fail(503, 'BUILD_CONSOLE_CLOSING');
    if (request.headers.host !== new URL(origin).host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) fail(403, 'BUILD_HOST_FORBIDDEN');
    if (request.headers.origin && request.headers.origin !== origin) fail(403, 'BUILD_ORIGIN_FORBIDDEN');
    if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) fail(403, 'BUILD_ORIGIN_FORBIDDEN');
    const raw = request.url ?? '';
    if (raw.length > 2048 || !raw.startsWith('/') || raw.startsWith('//') || /[\\#]|%(?:2f|5c|00)/i.test(raw)) fail(400, 'BUILD_PATH_INVALID');
    const url = new URL(raw, origin);
    if (url.pathname !== raw.split('?')[0]) fail(400, 'BUILD_PATH_INVALID');
    if (request.method === 'GET' && assets.has(url.pathname)) {
      query(url, []); const asset = assets.get(url.pathname); response.writeHead(200, { 'content-type': asset.type }); response.end(asset.bytes); return;
    }
    if (!url.pathname.startsWith('/api/')) fail(404, 'BUILD_ROUTE_NOT_FOUND');
    const mutation = !['GET', 'HEAD'].includes(request.method);
    if (mutation && request.headers.origin !== origin) fail(403, 'BUILD_ORIGIN_FORBIDDEN');
    if (url.pathname === '/api/session' && request.method === 'POST') {
      query(url, []); const input = fields(await body(request), ['code']);
      if (used || now() >= approvalExpires || ++attempts > 5 || typeof input.code !== 'string' || input.code.length !== 48
          || !timingSafeEqual(digest(input.code), approvalHash)) fail(401, 'BUILD_APPROVAL_INVALID');
      used = true; const key = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex'), expires = now() + SESSION_MS;
      sessions.set(key, { csrf, expires });
      // Secure cannot be required on plain HTTP. Binding and origin checks prohibit non-loopback use.
      response.setHeader('set-cookie', `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
      json(response, 200, { csrf, expires, apps: [...allowed], mode: 'local-owner' }); return;
    }
    const auth = session(request);
    let input;
    if (mutation) {
      input = request.method === 'DELETE' ? {} : await body(request, url.pathname === '/api/download');
      if (!equal(request.headers['x-flora-csrf'] ?? input?.csrf, auth.csrf)) fail(403, 'BUILD_CSRF_INVALID');
    }
    if (url.pathname === '/api/session') {
      query(url, []);
      if (request.method === 'GET') { json(response, 200, { csrf: auth.csrf, expires: auth.expires, apps: [...allowed], mode: 'local-owner' }); return; }
      if (request.method === 'DELETE') {
        sessions.delete(auth.key); prune(); response.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        json(response, 200, { loggedOut: true }); return;
      }
    }
    if (url.pathname === '/api/jobs') {
      if (request.method === 'GET') {
        const q = query(url, ['app', 'limit', 'after']); scoped(q.app); const limit = number(q.limit, 25);
        const jobs = service.list({ appId: q.app, limit, afterJobId: q.after ?? '' });
        json(response, 200, { jobs, nextCursor: jobs.length === limit ? jobs.at(-1).jobId : null }); return;
      }
      if (request.method === 'POST') {
        query(url, []); fields(input, ['appId', 'jobId', 'repository', 'sourceSha', 'platform', 'runnerId']); scoped(input.appId, input.jobId);
        json(response, 201, service.create(input)); return;
      }
    }
    const match = /^\/api\/jobs\/([^/]+)\/([^/]+)(?:\/(history|transition|downloads))?$/.exec(url.pathname);
    if (match) {
      const scope = scoped(match[1], match[2]), action = match[3];
      if (!action && request.method === 'GET') { query(url, []); json(response, 200, service.show(scope)); return; }
      if (action === 'history' && request.method === 'GET') {
        const q = query(url, ['limit', 'after']), limit = number(q.limit, 25);
        const events = service.history(scope, { limit, afterSequence: number(q.after, 0, Number.MAX_SAFE_INTEGER) });
        json(response, 200, { events, nextCursor: events.length === limit ? events.at(-1).sequence : null }); return;
      }
      if (action === 'transition' && request.method === 'POST') {
        query(url, []); fields(input, ['expectedVersion', 'status', 'idempotencyKey']);
        if (!['authorized', 'queued', 'cancelled'].includes(input.status)) fail(400, 'BUILD_ACTION_INVALID');
        const current = service.show(scope).job;
        if (input.status === 'cancelled' && !['queued', 'cancelled'].includes(current.status)) fail(409, 'BUILD_RUNNING_CANCEL_REQUIRES_RUNNER');
        const result = await service.transition({ scope, expectedVersion: input.expectedVersion, event: { status: input.status, idempotencyKey: input.idempotencyKey } });
        json(response, 200, result); return;
      }
      if (action === 'downloads' && request.method === 'POST') {
        query(url, []); fields(input, ['artifactId']);
        const artifact = service.show(scope).artifacts.find(a => a.artifactId === input.artifactId);
        if (!artifact) fail(404, 'BUILD_ARTIFACT_NOT_FOUND'); prune();
        if (tickets.size >= 128) fail(429, 'BUILD_DOWNLOAD_LIMIT');
        const ticket = randomBytes(32).toString('hex'), expires = Math.min(now() + TICKET_MS, auth.expires);
        tickets.set(ticket, { scope, artifact, sessionKey: auth.key, expires });
        json(response, 201, { ticket, expires, byteCount: artifact.byteCount, sha256: artifact.sha256 }); return;
      }
    }
    if (url.pathname === '/api/download' && request.method === 'POST') {
      query(url, []); fields(input, ['ticket', 'csrf']); prune();
      const ticket = typeof input.ticket === 'string' ? tickets.get(input.ticket) : null;
      if (!ticket || ticket.sessionKey !== auth.key || ticket.expires <= now()) fail(410, 'BUILD_DOWNLOAD_EXPIRED');
      if (activeDownloads >= 2) fail(429, 'BUILD_DOWNLOAD_LIMIT');
      tickets.delete(input.ticket); activeDownloads++;
      let staging;
      try {
        staging = await mkdtemp(join(directory, 'console-download-')); const targetPath = join(staging, 'artifact.bin');
        await service.export({ scope: ticket.scope, artifactId: ticket.artifact.artifactId, targetPath });
        if (response.destroyed || closing) fail(409, 'BUILD_DOWNLOAD_INTERRUPTED');
        session(request);
        const job = service.show(ticket.scope).job;
        await withVerifiedNativeArtifact({ filePath: targetPath, manifest: ticket.artifact, expected: job }, async (handle, receipt) => {
          response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': receipt.byteCount,
            'content-disposition': `attachment; filename="flora-${ticket.artifact.artifactId}.${ticket.artifact.format}"`,
            'x-flora-sha256': receipt.sha256, 'accept-ranges': 'none' });
          const buffer = Buffer.allocUnsafe(256 * 1024); let position = 0;
          while (position < receipt.byteCount) {
            if (response.destroyed || closing || !sessions.has(auth.key) || now() >= auth.expires) throw new Error('BUILD_DOWNLOAD_INTERRUPTED');
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, receipt.byteCount - position), position);
            if (!bytesRead) throw new Error('ARTIFACT_SOURCE_CHANGED'); position += bytesRead;
            // Copy the outgoing chunk: ServerResponse may retain it until the socket drains.
            if (!response.write(Buffer.from(buffer.subarray(0, bytesRead)))) await drain(response);
          }
        });
        response.end();
      } finally { activeDownloads--; if (staging) await rm(staging, { recursive: true, force: true }); }
      return;
    }
    fail(404, 'BUILD_ROUTE_NOT_FOUND');
  }
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const task = handle(request, response).catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      json(response, errorStatus(error), { error: publicError(error) });
    }).finally(() => pending.delete(task)); pending.add(task);
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000; server.maxConnections = 32;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { service.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, async close() {
    if (closing) return; closing = true; sessions.clear(); tickets.clear();
    const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections();
    await stopped; await Promise.allSettled([...pending]); service.close();
  } };
}
