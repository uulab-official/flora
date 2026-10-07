import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { decodeEvidence } from "./evidence.mjs";

// All frames/hashes are verified before any image is written. Use raw job logs,
// not a rendered/truncated connector preview. Output stays in ignored local work.
try {
  const [logPath, expectedCommit] = process.argv.slice(2);
  if (!logPath || !expectedCommit) throw new Error("USAGE");
  const evidence = decodeEvidence(await readFile(logPath, "utf8"), expectedCommit);
  const root = resolve(".superpowers"); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "dashboard-rendered-"));
  for (const file of evidence.files) await writeFile(join(directory, file.name), file.bytes, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ verifiedCommit: evidence.commit, files: evidence.files.length, privateDirectory: directory }));
} catch { console.error("RENDER_EVIDENCE_REJECTED: supply complete raw job log and exact expected commit; no screenshot success is implied"); process.exitCode = 1; }
