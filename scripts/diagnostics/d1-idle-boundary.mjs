// Manual synthetic transport characterization only; never part of test acceptance.
import { createTestRuntime } from '../../packages/cloudflare/test/runtime.ts';
import { observeD1Capacity } from '../../packages/cloudflare/test/d1-capacity-diagnostics.ts';

const mode = process.argv[2];
if (mode !== 'block' && mode !== 'yield') throw new Error('Choose the manual synthetic mode: block or yield');
const diagnostics = observeD1Capacity(message => console.error(message));
let runtime;
try {
  runtime = await createTestRuntime({ entrypoint: new URL('../../packages/cloudflare/test/fixtures/runtime-entry.ts', import.meta.url) });
  const db = runtime.d1;
  await db.exec('CREATE TABLE fixture (value INTEGER NOT NULL)');
  const insert = () => db.prepare('INSERT INTO fixture(value) VALUES(1)');
  await db.batch([insert(), insert(), insert()]);
  await db.batch([insert(), insert(), insert()]);
  diagnostics.beginBatch(3, 6);
  // Intentionally contrast timer starvation with a yielding control. No retry.
  if (mode === 'block') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
  else await new Promise(resolve => setTimeout(resolve, 6000));
  try {
    const pending = db.batch([insert(), insert(), insert()]);
    diagnostics.submitted();
    await pending;
  } catch (error) {
    // Read-only liveness/commit check; never resubmit the failed batch.
    try { console.error('D1_SYNTHETIC_STATE', JSON.stringify(await db.prepare('SELECT count(*) AS rows FROM fixture').first())); }
    catch { console.error('D1_SYNTHETIC_STATE', JSON.stringify({ probeSucceeded: 0 })); }
    diagnostics.rethrow(error);
  }
  console.error('D1_SYNTHETIC_STATE', JSON.stringify(await db.prepare('SELECT count(*) AS rows FROM fixture').first()));
} finally {
  diagnostics.dispose();
  await runtime?.dispose();
}
