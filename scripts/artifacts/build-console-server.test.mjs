import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { openLocalBuildService } from './local-build-service.mjs';
const mod = await import('./build-console-server.mjs').catch(() => ({}));
const job = { appId: 'app-a', jobId: 'job-one', repository: 'owner/private', sourceSha: 'a'.repeat(40), platform: 'android', runnerId: 'runner-one' };
const approvalCode = 'a'.repeat(48);
async function fixture(t) {
  assert.equal(typeof mod.startBuildConsole, 'function', 'console server API must exist');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'flora-http-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'state'), service = await openLocalBuildService({ directory, create: true });
  t.after(() => service.close()); service.create(job); service.create({ ...job, appId: 'app-secret' });
  let time = Date.now(); const server = await mod.startBuildConsole({ directory, appIds: ['app-a'], approvalCode, now: () => time });
  t.after(() => server.close());
  async function request(path, { method = 'GET', body, cookie, csrf, headers = {} } = {}) {
    return fetch(server.origin + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-flora-csrf': csrf } : {}), origin: server.origin, ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  const login = await request('/api/session', { method: 'POST', body: { code: approvalCode } });
  assert.equal(login.status, 200); const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0];
  const auth = { cookie, csrf: session.csrf };
  async function complete(bytes = Buffer.from('synthetic unsigned native artifact')) {
    for (const [index, status] of ['authorized', 'queued', 'running'].entries())
      await service.transition({ scope: job, expectedVersion: index, event: { status, idempotencyKey: String(index + 1).repeat(32) } });
    const sourcePath = join(root, 'fixture.apk'); await writeFile(sourcePath, bytes);
    const result = await service.complete({ scope: job, expectedVersion: 3, idempotencyKey: '4'.repeat(32), sourcePath, format: 'apk',
      manifest: { ...job, byteCount: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, execution: { ...job, exitCode: 0 } });
    return { bytes, artifact: result.artifact };
  }
  return { root, directory, service, server, request, auth, complete, advance: ms => { time += ms; } };
}
test('loopback console authenticates once, redacts paths and scopes every read', async t => {
  const f = await fixture(t);
  assert.match(f.server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await f.request('/api/jobs?app=app-a')).status, 401);
  const response = await f.request('/api/jobs?app=app-a', f.auth); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.jobs.length, 1); assert.equal(data.jobs[0].jobId, job.jobId);
  assert.equal(JSON.stringify(data).includes(f.root), false);
  for (const path of ['/api/jobs?app=app-secret', '/api/jobs/app-secret/job-one', '/api/jobs/app-secret/job-one/history'])
    assert.equal((await f.request(path, f.auth)).status, 403);
  assert.equal((await f.request('/api/session', { method: 'POST', body: { code: approvalCode } })).status, 401);
});
test('rejects hostile origins, Fetch Metadata, forged Host and CSRF-less mutation', async t => {
  const f = await fixture(t);
  for (const headers of [{ origin: 'https://evil.invalid' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }])
    assert.equal((await f.request('/api/jobs?app=app-a', { ...f.auth, headers })).status, 403);
  const result = await new Promise((resolve, reject) => {
    const req = http.get(f.server.origin + '/', { headers: { host: 'evil.invalid' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject);
  }); assert.equal(result, 403);
  assert.equal((await f.request('/api/jobs', { method: 'POST', cookie: f.auth.cookie, body: job })).status, 403);
  assert.equal((await f.request('/api/jobs/app-a/job-one/transition', { ...f.auth, method: 'POST', body: { status: 'succeeded', expectedVersion: 0, idempotencyKey: 'b'.repeat(32) } })).status, 400);
});
test('create and queue use the real durable service, conflict on stale versions, and paginate', async t => {
  const f = await fixture(t);
  const create = await f.request('/api/jobs', { ...f.auth, method: 'POST', body: { ...job, jobId: 'job-two' } }); assert.equal(create.status, 201);
  for (const [index, status] of ['authorized', 'queued'].entries()) {
    const body = { expectedVersion: index, status, idempotencyKey: String(index + 5).repeat(32) };
    assert.equal((await f.request('/api/jobs/app-a/job-one/transition', { ...f.auth, method: 'POST', body })).status, 200);
    assert.equal((await f.request('/api/jobs/app-a/job-one/transition', { ...f.auth, method: 'POST', body })).status, 200);
  }
  assert.equal(f.service.show(job).job.status, 'queued');
  assert.equal((await f.request('/api/jobs/app-a/job-one/transition', { ...f.auth, method: 'POST', body: { expectedVersion: 0, status: 'cancelled', idempotencyKey: 'f'.repeat(32) } })).status, 409);
  const first = await (await f.request('/api/jobs?app=app-a&limit=1', f.auth)).json(); assert.equal(first.jobs.length, 1); assert.equal(first.nextCursor, 'job-one');
  const second = await (await f.request('/api/jobs?app=app-a&limit=1&after=job-one', f.auth)).json(); assert.equal(second.jobs[0].jobId, 'job-two');
  const history = await (await f.request('/api/jobs/app-a/job-one/history?limit=1&after=1', f.auth)).json(); assert.equal(history.events[0].status, 'authorized');
});
test('HTTP refuses running cancellation instead of falsely reporting process termination', async t => {
  const f = await fixture(t);
  for (const [i, status] of ['authorized', 'queued', 'running'].entries()) await f.service.transition({ scope: job, expectedVersion: i, event: { status, idempotencyKey: String(i + 1).repeat(32) } });
  assert.equal((await f.request('/api/jobs/app-a/job-one/transition', { ...f.auth, method: 'POST', body: { expectedVersion: 3, status: 'cancelled', idempotencyKey: 'b'.repeat(32) } })).status, 409);
  assert.equal(f.service.show(job).job.status, 'running');
});
test('download is verified, single-use, session-bound, absent from URLs and cleans staging', async t => {
  const f = await fixture(t), { bytes, artifact } = await f.complete();
  const ticketResponse = await f.request('/api/jobs/app-a/job-one/downloads', { ...f.auth, method: 'POST', body: { artifactId: artifact.artifactId } });
  assert.equal(ticketResponse.status, 201); const { ticket } = await ticketResponse.json();
  assert.equal((await f.request('/api/download', { method: 'POST', body: { ticket } })).status, 401);
  const downloaded = await f.request('/api/download', { ...f.auth, method: 'POST', body: { ticket } }); assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /attachment; filename="flora-[a-f0-9]+\.apk"/);
  assert.equal(downloaded.headers.get('cache-control'), 'no-store'); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  assert.equal((await f.request('/api/download', { ...f.auth, method: 'POST', body: { ticket } })).status, 410);
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal((await readdir(f.directory)).some(name => name.startsWith('console-download-')), false);
});
test('single-use download is consumed atomically under concurrent requests', async t => {
  const f = await fixture(t), { artifact } = await f.complete();
  const { ticket } = await (await f.request('/api/jobs/app-a/job-one/downloads', { ...f.auth, method: 'POST', body: { artifactId: artifact.artifactId } })).json();
  const responses = await Promise.all([1, 2].map(() => f.request('/api/download', { ...f.auth, method: 'POST', body: { ticket } })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 410]); for (const r of responses) await r.arrayBuffer();
});
test('corrupted file never returns a download body, and ticket is not reusable', async t => {
  const f = await fixture(t), { bytes, artifact } = await f.complete();
  const { ticket } = await (await f.request('/api/jobs/app-a/job-one/downloads', { ...f.auth, method: 'POST', body: { artifactId: artifact.artifactId } })).json();
  await writeFile(join(f.directory, 'artifacts', job.appId, job.jobId, artifact.artifactId + '.bin'), Buffer.alloc(bytes.length, 66));
  const response = await f.request('/api/download', { ...f.auth, method: 'POST', body: { ticket } }); assert.equal(response.status, 409);
  const text = await response.text(); assert.match(text, /ARTIFACT_HASH_MISMATCH/); assert.equal(text.includes(f.root), false);
});
test('ticket expiry, logout and server restart revoke access', async t => {
  const f = await fixture(t), { artifact } = await f.complete();
  const { ticket } = await (await f.request('/api/jobs/app-a/job-one/downloads', { ...f.auth, method: 'POST', body: { artifactId: artifact.artifactId } })).json();
  f.advance(61_000); assert.equal((await f.request('/api/download', { ...f.auth, method: 'POST', body: { ticket } })).status, 410);
  assert.equal((await f.request('/api/session', { ...f.auth, method: 'DELETE' })).status, 200);
  assert.equal((await f.request('/api/jobs?app=app-a', f.auth)).status, 401);
});
test('session expiry, request limits and unknown fields fail closed', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/jobs', { ...f.auth, method: 'POST', body: { ...job, sourcePath: '/etc/passwd' } })).status, 400);
  assert.equal((await f.request('/api/jobs?app=app-a&app=app-secret', f.auth)).status, 400);
  assert.equal((await f.request('/api/jobs?app=app-a&limit=999999', f.auth)).status, 400);
  assert.equal((await f.request('/api/jobs', { ...f.auth, method: 'POST', body: { payload: 'x'.repeat(17000) } })).status, 413);
  f.advance(30 * 60_000 + 1); assert.equal((await f.request('/api/session', f.auth)).status, 401);
});
test('public shell includes restrictive security headers and no private state', async t => {
  const f = await fixture(t), response = await f.request('/'); assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const html = await response.text(); assert.equal(html.includes(approvalCode), false); assert.equal(html.includes(job.repository), false);
  assert.match(html, /console\.mjs/);
});
test('native browser form POST downloads without putting a ticket in the URL', async t => {
  const f = await fixture(t), { bytes, artifact } = await f.complete();
  const { ticket } = await (await f.request('/api/jobs/app-a/job-one/downloads', { ...f.auth, method: 'POST', body: { artifactId: artifact.artifactId } })).json();
  const response = await fetch(f.server.origin + '/api/download', { method: 'POST', headers: { origin: f.server.origin, cookie: f.auth.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket, csrf: f.auth.csrf }) });
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});
test('multi-chunk downloads preserve the digest and disconnect cleans private staging', async t => {
  const f = await fixture(t), { bytes, artifact } = await f.complete(Buffer.alloc(4 * 1024 * 1024, 83));
  async function ticket() { return (await (await f.request('/api/jobs/app-a/job-one/downloads', { ...f.auth, method: 'POST', body: { artifactId: artifact.artifactId } })).json()).ticket; }
  const response = await f.request('/api/download', { ...f.auth, method: 'POST', body: { ticket: await ticket() } });
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const payload = JSON.stringify({ ticket: await ticket() });
  await new Promise((resolve, reject) => {
    const request = http.request(f.server.origin + '/api/download', { method: 'POST', headers: { origin: f.server.origin, cookie: f.auth.cookie, 'x-flora-csrf': f.auth.csrf, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, response => {
      response.once('data', () => { response.destroy(); resolve(); }); response.on('error', () => {});
    }); request.on('error', reject); request.end(payload);
  });
  for (let i = 0; i < 50; i++) { if (!(await readdir(f.directory)).some(n => n.startsWith('console-download-'))) break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal((await readdir(f.directory)).some(n => n.startsWith('console-download-')), false);
});
