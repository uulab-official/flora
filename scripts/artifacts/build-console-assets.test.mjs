import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const asset = name => readFile(new URL('console/' + name, import.meta.url), 'utf8');
test('console has accessible login, app scope, job table, create dialog and download form', async () => {
  const html = await asset('index.html');
  for (const id of ['login-form', 'approval-code', 'app-select', 'job-rows', 'job-detail', 'create-dialog', 'download-form', 'notice'])
    assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /aria-live="polite"/); assert.match(html, /<label/); assert.match(html, /<table/); assert.match(html, /<dialog/);
  assert.match(html, /method="post" action="\/api\/download"/);
  assert.doesNotMatch(html, /https?:\/\//);
});
test('console JS uses safe text nodes, scope epochs and no persistent secrets or inline event HTML', async () => {
  const js = await asset('console.mjs');
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage|eval\(/);
  assert.match(js, /textContent/); assert.match(js, /epoch/); assert.match(js, /x-flora-csrf/);
  assert.match(js, /nextCursor/); assert.match(js, /BUILD_VERSION_CONFLICT/);
});
test('console layout supplies mobile and reduced motion rules without remote assets', async () => {
  const css = await asset('console.css');
  assert.match(css, /@media.*max-width/); assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /@import|https?:\/\//);
});
test('console includes explicit execution confirmation, retry lineage and app-wide metrics', async () => {
  const html = await asset('index.html'), js = await asset('console.mjs');
  for (const id of ['run-dialog', 'run-form', 'run-context', 'retry-dialog', 'retry-form', 'retry-job-id', 'runner-mode', 'execution-status'])
    assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /앱 전체 작업/); assert.doesNotMatch(html, /현재 페이지 작업<\/span>/);
  for (const endpoint of ['/api/overview', '/api/presets', '/execute', '/stop', '/retry', '/execution']) assert.ok(js.includes(endpoint), endpoint);
  assert.match(js, /parentJobId/); assert.match(js, /BUILD_SOURCE_DIRTY/);
  assert.doesNotMatch(html, /name="(?:executable|args|cwd|sourcePath)"/);
});
