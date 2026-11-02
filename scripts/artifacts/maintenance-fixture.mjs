import { mkdtemp, realpath, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openLocalBuildService } from './local-build-service.mjs';

export async function maintenanceFixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'flora-maintenance-'));
  const directory = join(root, 'state'), service = await openLocalBuildService({ directory, create: true });
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }); });
  const context = { appId: 'app-a', jobId: 'one', repository: 'owner/app', sourceSha: 'a'.repeat(40), runnerId: 'runner-a', platform: 'android' };
  const bytes = Buffer.from('synthetic unsigned backup artifact'), sourcePath = join(root, 'source.apk');
  await writeFile(sourcePath, bytes);
  async function completed(jobId, appId = 'app-a') {
    const job = { ...context, jobId, appId }; service.create(job);
    for (const [i, status] of ['authorized','queued','running'].entries())
      await service.transition({scope:job,expectedVersion:i,event:{status,idempotencyKey:String(i+1).repeat(32)}});
    return service.complete({scope:job,expectedVersion:3,idempotencyKey:'4'.repeat(32),execution:{...job,exitCode:0},format:'apk',sourcePath,
      manifest:{...job,byteCount:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}});
  }
  return {root,directory,service,context,bytes,completed};
}
