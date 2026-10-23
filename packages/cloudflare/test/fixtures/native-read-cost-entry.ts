import type { DurableObjectState } from '@cloudflare/workers-types';
import type { FloraEnv } from '../../src/contracts.js';
import { NativeHttpFixture as BaseFixture } from './native-http-entry.js';
export { default } from './native-http-entry.js';

// Local-only instrumentation: keep the original cursor and read its counters
// after the real HTTP handler has consumed it. Never copy SQL argument values.
type Sample = { query: string; cursor: ReturnType<DurableObjectState['storage']['sql']['exec']> };
export class NativeHttpFixture extends BaseFixture {
  private readonly measurement: { samples: Sample[] | null };
  constructor(ctx: DurableObjectState, env: FloraEnv) {
    const measurement: { samples: Sample[] | null } = { samples: null };
    const sql = ctx.storage.sql, exec = sql.exec.bind(sql);
    sql.exec = ((query: string, ...values: (string | number | null | ArrayBuffer)[]) => {
      const cursor = exec(query, ...values);
      measurement.samples?.push({ query, cursor });
      return cursor;
    }) as typeof sql.exec;
    super(ctx, env);
    this.measurement = measurement;
  }
  override async fetch(request: Request): Promise<Response> {
    if (!request.headers.has('X-Flora-Test-Measure-Sql')) return super.fetch(request);
    if (this.measurement.samples) throw new Error('Concurrent SQL profiles are not supported');
    const samples: Sample[] = [];
    this.measurement.samples = samples;
    try {
      let response: Response;
      if (new URL(request.url).pathname === '/__test/native-restart') {
        await request.arrayBuffer();
        await super.fetch(new Request(new URL('/__test/control', request.url), { method: 'POST', body: JSON.stringify({ restart: true }) }));
        // Wait for the new authority's blockConcurrencyWhile before counting.
        response = await super.fetch(new Request(new URL('/api/auth/session', request.url), { headers: { Cookie: request.headers.get('Cookie') ?? '' } }));
      } else response = await super.fetch(request);
      const sum = (selected: Sample[]) => selected.reduce((total, sample) => total + sample.cursor.rowsRead, 0);
      const indexes = samples.filter(sample => sample.query.startsWith('CREATE INDEX IF NOT EXISTS flora_native_jobs_'));
      response.headers.set('X-Flora-Test-Sql', JSON.stringify({
        queries: samples.length, rowsRead: sum(samples),
        rowsWritten: samples.reduce((total, sample) => total + sample.cursor.rowsWritten, 0),
        jobRows: sum(samples.filter(sample => sample.query.includes('flora_native_jobs'))),
        authRows: sum(samples.filter(sample => sample.query.includes('flora_auth_'))),
        indexRows: sum(indexes), indexWrites: indexes.reduce((total, sample) => total + sample.cursor.rowsWritten, 0),
      }));
      return response;
    } finally { this.measurement.samples = null; }
  }
}
