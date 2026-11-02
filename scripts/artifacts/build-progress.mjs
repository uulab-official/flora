import { performance } from 'node:perf_hooks';

const stages = new Set(['preflight', 'source-check', 'executing', 'verifying', 'publishing', 'finished']);
// Bounded, structured observations only. Raw process output never enters the observer.
export function createBuildProgress({ onProgress, outputLimitBytes, timeoutMs }) {
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new Error('BUILD_PROGRESS_INVALID');
  const start = performance.now(); let last = -Infinity, stage = 'preflight', stdoutBytes = 0, stderrBytes = 0, lastOutputAt = null;
  function emit(force = false) {
    const current = performance.now();
    if (!force && current - last < 250) return;
    last = current;
    const value = Object.freeze({ stage, elapsedMs: Math.max(0, Math.floor(current - start)),
      stdoutBytes, stderrBytes, outputLimitBytes, timeoutMs, lastOutputAt,
      observedAt: new Date().toISOString(), live: stage !== 'finished' });
    // Observers are informational. A display bug/rejected promise must not kill a build.
    try { const result = onProgress?.(value); if (result && typeof result.catch === 'function') result.catch(() => {}); } catch {}
  }
  return Object.freeze({
    stage(value) { if (!stages.has(value)) throw new Error('BUILD_PROGRESS_INVALID'); stage = value; emit(true); },
    output(kind, count) {
      if (!['stdout', 'stderr'].includes(kind) || !Number.isSafeInteger(count) || count < 0) throw new Error('BUILD_PROGRESS_INVALID');
      const first = lastOutputAt === null;
      if (kind === 'stdout') stdoutBytes += count; else stderrBytes += count;
      lastOutputAt = new Date().toISOString(); emit(first);
    },
    tick() { emit(); },
    finish() { stage = 'finished'; emit(true); },
  });
}
