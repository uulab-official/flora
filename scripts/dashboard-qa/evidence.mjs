import { createHash } from "node:crypto";
export const LIMITS = Object.freeze({ files: 16, fileBytes: 512 * 1024, totalBytes: 4 * 1024 * 1024, logBytes: 8 * 1024 * 1024, chunkChars: 4096, lineBytes: 8192 });
const PREFIX = "FLORA_QA_V1 ";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function requireValue(value) { if (!value) throw new Error("INVALID_RENDER_EVIDENCE"); }
function shape(value, keys) { requireValue(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join()); }
function commitId(value) { requireValue(typeof value === "string" && /^[a-f0-9]{40}$/.test(value)); }
function filename(value) { requireValue(typeof value === "string" && /^synthetic-[a-z0-9][a-z0-9-]{0,70}\.(png|json)$/.test(value)); }
function contents(name, bytes) {
  requireValue(bytes.length > 0 && bytes.length <= LIMITS.fileBytes);
  if (name.endsWith(".png")) requireValue(bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")));
  else requireValue(JSON.parse(bytes.toString("utf8")).syntheticOnly === true);
}
export function encodeEvidence(files, commit) {
  commitId(commit); requireValue(Array.isArray(files) && files.length > 0 && files.length <= LIMITS.files);
  const owned = files.map(file => { shape(file, ["name", "bytes"]); filename(file.name); requireValue(file.bytes instanceof Uint8Array); const bytes = Buffer.from(file.bytes); contents(file.name, bytes); return { name: file.name, bytes }; });
  requireValue(new Set(owned.map(file => file.name)).size === owned.length);
  const totalBytes = owned.reduce((sum, file) => sum + file.bytes.length, 0); requireValue(totalBytes <= LIMITS.totalBytes);
  const manifest = { kind: "manifest", commit, syntheticOnly: true, totalBytes, files: owned.map(file => ({ name: file.name, bytes: file.bytes.length, sha256: sha(file.bytes), chunks: Math.ceil(file.bytes.toString("base64").length / LIMITS.chunkChars) })) };
  const lines = [PREFIX + JSON.stringify(manifest)];
  for (const file of owned) { const base64 = file.bytes.toString("base64"); for (let index = 0; index * LIMITS.chunkChars < base64.length; index++) lines.push(PREFIX + JSON.stringify({ kind: "chunk", name: file.name, index, data: base64.slice(index * LIMITS.chunkChars, (index + 1) * LIMITS.chunkChars) })); }
  lines.push(PREFIX + JSON.stringify({ kind: "end", manifestSha256: sha(JSON.stringify(manifest)) }));
  requireValue(lines.every(line => Buffer.byteLength(line) <= LIMITS.lineBytes) && Buffer.byteLength(lines.join("\n")) <= LIMITS.logBytes);
  return lines;
}
export function decodeEvidence(log, expectedCommit) {
  commitId(expectedCommit); requireValue(typeof log === "string" && Buffer.byteLength(log) <= LIMITS.logBytes);
  const frames = [];
  for (const line of log.split(/\r?\n/)) { const at = line.indexOf(PREFIX); if (at < 0) continue; requireValue(at <= 100 && line.length - at <= LIMITS.lineBytes); frames.push(JSON.parse(line.slice(at + PREFIX.length))); }
  requireValue(frames.length >= 3);
  const manifest = frames.shift(); const end = frames.pop();
  shape(manifest, ["kind", "commit", "syntheticOnly", "totalBytes", "files"]); shape(end, ["kind", "manifestSha256"]);
  requireValue(manifest.kind === "manifest" && end.kind === "end" && end.manifestSha256 === sha(JSON.stringify(manifest)));
  requireValue(manifest.commit === expectedCommit && manifest.syntheticOnly === true && Number.isSafeInteger(manifest.totalBytes) && manifest.totalBytes > 0 && manifest.totalBytes <= LIMITS.totalBytes);
  requireValue(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= LIMITS.files);
  const files = []; const names = new Set(); let total = 0;
  for (const entry of manifest.files) {
    shape(entry, ["name", "bytes", "sha256", "chunks"]); filename(entry.name); requireValue(!names.has(entry.name)); names.add(entry.name);
    requireValue(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= LIMITS.fileBytes && /^[a-f0-9]{64}$/.test(entry.sha256));
    const encodedLength = Math.ceil(entry.bytes / 3) * 4;
    requireValue(entry.chunks === Math.ceil(encodedLength / LIMITS.chunkChars));
    let base64 = "";
    for (let index = 0; index < entry.chunks; index++) {
      const chunk = frames.shift(); shape(chunk, ["kind", "name", "index", "data"]);
      requireValue(chunk.kind === "chunk" && chunk.name === entry.name && chunk.index === index && typeof chunk.data === "string" && chunk.data.length === Math.min(LIMITS.chunkChars, encodedLength - index * LIMITS.chunkChars));
      requireValue(/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.data)); base64 += chunk.data;
    }
    const bytes = Buffer.from(base64, "base64"); requireValue(bytes.toString("base64") === base64 && bytes.length === entry.bytes && sha(bytes) === entry.sha256); contents(entry.name, bytes);
    total += bytes.length; requireValue(total <= LIMITS.totalBytes); files.push({ name: entry.name, bytes });
  }
  requireValue(frames.length === 0 && total === manifest.totalBytes);
  return { commit: manifest.commit, files };
}
