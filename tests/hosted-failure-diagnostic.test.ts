import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFailureDiagnostic } from '../scripts/hosted-qa/failure-diagnostic.mjs';

test('browser failure diagnostics retain operation and owned code locations without private error text', () => {
  const error = { name: 'TimeoutError', message: "locator.fill: Timeout 15000ms exceeded.\nwaiting for locator('#token')\nSECRET_PASSWORD owner@private.test",
    stack: 'TimeoutError: SECRET_TOKEN\n at authenticate (file:///private/workspace/scripts/hosted-qa/capture.mjs:320:39)\n at test (file:///private/workspace/scripts/hosted-qa/capture.mjs:393:24)\n at secret (/private/SECRET_FILE.js:12:4)' };
  assert.deepEqual(browserFailureDiagnostic(error), { name: 'TimeoutError', operation: 'locator.fill', selectors: ['#token'],
    frames: [{ file: 'hosted-qa/capture.mjs', line: 320, column: 39 }, { file: 'hosted-qa/capture.mjs', line: 393, column: 24 }] });
  assert.doesNotMatch(JSON.stringify(browserFailureDiagnostic(error)), /SECRET|private|owner@/);
});

test('browser failure diagnostics bound output and reject arbitrary locators, names, operations and stack paths', () => {
  const error = { name: 'SECRET', message: "SECRET.method: private\nlocator('input[value=SECRET]')\nlocator('#SECRET')",
    stack: ' at a (/private/SECRET/capture.mjs:9:8)\n at b (/private/scripts/hosted-qa/SECRET.mjs:9:8)' };
  assert.deepEqual(browserFailureDiagnostic(error), { name: 'Error', operation: null, selectors: [], frames: [] });
  const repeated = { name: 'AssertionError', message: "page.waitForResponse: secret\n" + "locator('#email')\n".repeat(50),
    stack: (' at a (/private/scripts/hosted-qa/capture.mjs:123:45)\n').repeat(50) };
  const result = browserFailureDiagnostic(repeated);
  assert.equal(result.operation, 'page.waitForResponse'); assert.deepEqual(result.selectors, ['#email']); assert.ok(result.frames.length <= 4);
  assert.deepEqual(browserFailureDiagnostic(null), { name: 'Error', operation: null, selectors: [], frames: [] });
});
