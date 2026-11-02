import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { openDurableBuildLedger } from './durable-build-ledger.mjs';
import { isBuildId, snapshotBuildScope } from './build-lifecycle.mjs';
import { privateDirectory } from './private-paths.mjs';
import { publishLocalArtifact, resolveLocalArtifact, exportLocalArtifact, discardUncommittedArtifact } from './local-artifact-store.mjs';

const safeError = error => /^[A-Z][A-Z_]{1,80}$/.test(error?.message ?? '') ? error.message
  : error?.code === 'ENOENT' ? 'ARTIFACT_MISSING' : 'ARTIFACT_CHECK_FAILED';
export async function openLocalBuildService({ directory, create = false, readOnly = false }) {
  const ledger = await openDurableBuildLedger({ directory, create, readOnly });
  try {
    directory = await privateDirectory(directory);
    const root = join(directory, 'artifacts'); await privateDirectory(root, { create });
    return new LocalBuildService(ledger, root, readOnly);
  } catch (error) { ledger.close(); throw error; }
}
class LocalBuildService {
  #ledger; #root; #readOnly;
  constructor(ledger, root, readOnly) { this.#ledger = ledger; this.#root = root; this.#readOnly = readOnly; }
  create(job) { return this.#ledger.create(job); }
  transition(request) { return this.#ledger.transition(request); }
  recordProgress(request) { return this.#ledger.recordProgress(request); }
  retry(request) { return this.#ledger.retry(request); }
  overview(options) { return this.#ledger.overview(options); }
  list(options) { return this.#ledger.list(options); }
  history(scope, options) { return this.#ledger.history(scope, options); }
  show(scope) { return { job: this.#ledger.get(scope), artifacts: this.#ledger.artifacts(scope) }; }
  async complete(input) {
    if (this.#readOnly) throw new Error('BUILD_LEDGER_READ_ONLY');
    // Copy primitives before the first await. Never use manifest as the authorized job.
    const request = { scope: snapshotBuildScope(input.scope), expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey, manifest: { ...input.manifest }, execution: { ...input.execution }, format: input.format };
    const sourcePath = input.sourcePath, prepared = this.#ledger.prepareCompletion(request), job = prepared.job;
    if (prepared.replay) {
      await resolveLocalArtifact({ root: this.#root, receipt: prepared.replay.artifact, authorizedJob: job });
      return prepared.replay;
    }
    const receipt = await publishLocalArtifact({ root: this.#root, sourcePath, manifest: request.manifest, authorizedJob: job });
    let result;
    try { result = await this.#ledger.complete({ ...request, receipt }); }
    catch (error) {
      // These errors are known rollbacks. IO/ambiguous commit failures retain the file
      // for doctor to reconcile; deleting it could erase a committed artifact.
      if (['BUILD_VERSION_CONFLICT', 'BUILD_IDEMPOTENCY_CONFLICT', 'BUILD_TRANSITION_DENIED', 'BUILD_ARTIFACT_NOT_VERIFIED'].includes(error.message))
        await discardUncommittedArtifact({ root: this.#root, receipt, authorizedJob: job });
      throw error;
    }
    if (result.artifact.artifactId !== receipt.artifactId)
      await discardUncommittedArtifact({ root: this.#root, receipt, authorizedJob: job });
    return result;
  }
  async export({ scope, artifactId, targetPath }) {
    const job = this.#ledger.get(scope), artifact = this.#ledger.artifact(scope, artifactId);
    await exportLocalArtifact({ root: this.#root, receipt: artifact, authorizedJob: job, targetPath });
    return Object.freeze({ artifactId, byteCount: artifact.byteCount, sha256: artifact.sha256,
      format: artifact.format, integrityVerified: true, signatureVerified: false, installVerified: false });
  }
  async doctor({ appId, maxBytes = 256 * 1024 * 1024, maxEntries = 1000 } = {}) {
    if ((appId !== undefined && !isBuildId(appId)) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024 * 1024
        || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000) throw new Error('BUILD_QUERY_INVALID');
    const database = this.#ledger.diagnostics({ appId }), inventory = [], issues = [];
    let after = null;
    while (inventory.length < maxEntries) {
      const batch = this.#ledger.inventory({ appId, after, limit: Math.min(100, maxEntries - inventory.length) });
      if (!batch.length) break;
      inventory.push(...batch); after = batch.at(-1);
    }
    let complete = inventory.length === database.artifacts, consumed = 0, verifiedFiles = 0, scannedEntries = 0;
    const referenced = new Set(inventory.map(a => `${a.appId}/${a.jobId}/${a.artifactId}.bin`));
    for (const artifact of inventory) {
      if (consumed + artifact.byteCount > maxBytes) { complete = false; continue; }
      consumed += artifact.byteCount;
      try {
        await resolveLocalArtifact({ root: this.#root, receipt: artifact, authorizedJob: this.#ledger.get(artifact) }); verifiedFiles++;
      } catch (error) { issues.push({ appId: artifact.appId, jobId: artifact.jobId, artifactId: artifact.artifactId, code: safeError(error) }); }
    }
    let scanComplete = true;
    async function walk(directory, parts = []) {
      try { await privateDirectory(directory); }
      catch (error) {
        // An app without artifacts need not have a directory yet. Other failures are findings.
        if (parts.length === 1 && error.code === 'ENOENT') return;
        issues.push({ code: 'ARTIFACT_STORE_DIRECTORY_UNSAFE' }); return;
      }
      for await (const entry of await opendir(directory)) {
        if (++scannedEntries > maxEntries) { scanComplete = false; break; }
        if (parts.length < 2 && entry.isDirectory() && isBuildId(entry.name)) {
          await walk(join(directory, entry.name), [...parts, entry.name]);
          if (!scanComplete) break;
        } else if (parts.length === 2 && entry.isFile() && /^[a-f0-9]{24}\.bin$/.test(entry.name)) {
          if (!referenced.has([...parts, entry.name].join('/')) && inventory.length === database.artifacts)
            issues.push({ appId: parts[0], jobId: parts[1], code: 'ARTIFACT_UNREFERENCED' });
        } else if (parts.length === 2 && entry.isFile() && entry.name.startsWith('.') && entry.name.endsWith('.partial')) {
          issues.push({ appId: parts[0], jobId: parts[1], code: 'ARTIFACT_PARTIAL_REMAINS' });
        } else { issues.push({ code: 'ARTIFACT_UNEXPECTED_ENTRY' }); }
      }
    }
    await walk(appId === undefined ? this.#root : join(this.#root, appId), appId === undefined ? [] : [appId]);
    complete &&= scanComplete;
    const end = this.#ledger.diagnostics({ appId });
    if (end.revision !== database.revision || end.artifacts !== database.artifacts) {
      complete = false; issues.push({ code: 'BUILD_DIAGNOSTIC_STATE_CHANGED' });
    }
    if (!complete) issues.push({ code: 'ARTIFACT_SCAN_INCOMPLETE' });
    if ((database.states.unknown ?? 0) > 0) issues.push({ code: 'BUILD_RECONCILIATION_REQUIRED' });
    if ((database.states.running ?? 0) > 0) issues.push({ code: 'BUILD_RUNNING_REQUIRES_CHECK' });
    return { ...database, verifiedFiles, verifiedBytes: consumed, scannedEntries, complete, issues,
      ready: database.databaseIntegrity && complete && issues.length === 0 };
  }
  close() { this.#ledger.close(); }
}
