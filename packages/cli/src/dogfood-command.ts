import { DomainError, ensure, id, safeJson } from "@app-ops/core";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { applicationId, parseAutoPolicyUpdate, parseAutomationQueueInput, parseRunnerEnrollmentInput, createGitHubAutomationSourceProvider, createGitHubResolver, createRSAManifestSigner, OTA_ASSET_MAX_BYTES, parseGitHubConnectionUpdate, parseOTAAssetUpload, parseOTAPublishInput, parseApplicationRegistration, parseSettingsUpdate, parseSourceBundle } from "@app-ops/dogfood";
import { openDatabase, migrate, createSqliteDogfoodStore, acquireDashboardOwner, releaseDashboardOwner, interruptVerifications } from "@app-ops/db";
import { createDogfoodService } from "@app-ops/dashboard/service";
import { createBlockedProvider } from "@app-ops/dashboard/blocked-provider";
import type { CliIO } from "./main.js";
import { readDogfoodInputFile } from "./dogfood-input.js";
import { preparePrivateStore, verifyPrivateStore } from "./private-store.js";

const help = "Flora local dogfood\n" +
  "flora dogfood serve [--db <path>] [--port <0..65535>]\n" +
  "flora dogfood register-app --file <registration.json> [--db <path>]\n" +
  "flora dogfood settings --app <app_id> --file <settings.json> [--db <path>]\n" +
  "flora dogfood import-source --file <json> [--app <app_id>] [--db <path>]\n" +
  "flora dogfood import-baseline --snapshot <inventory_id> --file <json> [--app <app_id>] [--db <path>]\n" +
  "flora dogfood status [--app <app_id>] [--db <path>] --json\n" +
  "flora dogfood github-connect --app <app_id> --file <connection.json> [--resolved-config <json>] [--db <path>]\n" +
  "flora dogfood ota-upload --app <app_id> --file <binary> --key <expo_key> --file-extension <.ext> --content-type <type> [--db <path>]\n" +
  "flora dogfood ota-publish --app <app_id> --file <deployment.json> [--db <path>]\n" +
  "flora dogfood operations --app <app_id> --json [--db <path>]\n" +
  "flora dogfood runner-enroll --file <runner.json> [--db <path>]\n" +
  "flora dogfood runner-revoke --runner <runner_id> [--db <path>]\n" +
  "flora dogfood automation-queue --app <app_id> --file <job.json> [--db <path>]\n" +
  "flora dogfood automation-policy --app <app_id> --file <policy.json> [--db <path>]\n" +
  "flora dogfood automation-cancel --app <app_id> --job <job_id> [--db <path>]\n" +
  "flora dogfood automation --app <app_id> --json [--db <path>]\n" +
  "Automation commands require canonical FLORA_OTA_ORIGIN.\n" +
  "Static imports are operator evidence. No native builds or verified isolated execution.\n";
type CommandName = "status" | "import-source" | "import-baseline" | "serve" | "register-app" | "settings" | "github-connect" | "ota-upload" | "ota-publish" | "operations" | "runner-enroll" | "runner-revoke" | "automation-queue" | "automation-policy" | "automation-cancel" | "automation";
const automationCommands: readonly CommandName[] = ["runner-enroll","runner-revoke","automation-queue","automation-policy","automation-cancel","automation"];
type Command = { name: CommandName; dbPath?: string; file?: string; snapshotId?: string; appId?: string; port?: number; resolvedConfigFile?: string; assetKey?: string; fileExtension?: string; contentType?: string; runnerId?: string; jobId?: string };
function parse(args: readonly string[]): Command | null {
  const name = args[0] as CommandName;
  const flags: Record<CommandName,string[]> = {
    status:["--db","--json","--app"], serve:["--db","--port"],
    "register-app":["--db","--file"], settings:["--db","--file","--app"],
    "import-source":["--db","--file","--app"], "import-baseline":["--db","--file","--snapshot","--app"],
    "github-connect":["--db","--file","--app","--resolved-config"],
    "ota-upload":["--db","--file","--app","--key","--file-extension","--content-type"],
    "ota-publish":["--db","--file","--app"], operations:["--db","--app","--json"],
    "runner-enroll":["--db","--file"], "runner-revoke":["--db","--runner"],
    "automation-queue":["--db","--app","--file"], "automation-policy":["--db","--app","--file"],
    "automation-cancel":["--db","--app","--job"], automation:["--db","--app","--json"],
  };
  if (!Object.hasOwn(flags,name)) return null;
  const allowed = new Set(flags[name]), options = new Map<string,string>();
  for (let i=1;i<args.length;i++) {
    const flag = args[i]!; if (!allowed.has(flag)||options.has(flag)) return null;
    if (flag === "--json") options.set(flag,"true");
    else { const value = args[++i]; if (!value||value.startsWith("--")||value.includes("\0")) return null; options.set(flag,value); }
  }
  if (["status","operations","automation"].includes(name)&&!options.has("--json")) return null;
  if (!["status","operations","serve","automation","automation-cancel","runner-revoke"].includes(name)&&!options.has("--file")) return null;
  const snapshotId = options.get("--snapshot"), port = options.get("--port"), appId = options.get("--app"), runnerId = options.get("--runner"), jobId = options.get("--job");
  if (name === "runner-revoke"&&!runnerId || name === "automation-cancel"&&!jobId) return null;
  for (const value of [runnerId,jobId]) if (value!==undefined) {try {id(value);} catch {return null;}}
  if (["settings","github-connect","ota-upload","ota-publish","operations","automation-queue","automation-policy","automation-cancel","automation"].includes(name)&&!appId) return null;
  if (appId !== undefined) { try { applicationId(appId); } catch { return null; } }
  if (name === "ota-upload"&&["--key","--file-extension","--content-type"].some(flag=>!options.has(flag))) return null;
  if (name === "import-baseline"&&(!snapshotId||!/^inventory_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(snapshotId))) return null;
  if (port !== undefined&&(!/^(0|[1-9][0-9]{0,4})$/.test(port)||Number(port)>65535)) return null;
  return { name,...(options.has("--db")?{dbPath:options.get("--db")!}:{}),...(options.has("--file")?{file:options.get("--file")!}:{}),
    ...(runnerId?{runnerId}:{}),...(jobId?{jobId}:{}),...(snapshotId?{snapshotId}:{}),...(appId?{appId}:{}),...(port!==undefined?{port:Number(port)}:{}),
    ...(options.has("--resolved-config")?{resolvedConfigFile:options.get("--resolved-config")!}:{}),
    ...(options.has("--key")?{assetKey:options.get("--key")!}:{}),
    ...(options.has("--file-extension")?{fileExtension:options.get("--file-extension")!}:{}),
    ...(options.has("--content-type")?{contentType:options.get("--content-type")!}:{}) };
}

function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new DomainError("INVALID_INPUT"); }
}

async function readOTAFile(path: string): Promise<Uint8Array> {
  try {
    const file = await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const stat = await file.stat(); ensure(stat.isFile()); ensure(stat.size<=OTA_ASSET_MAX_BYTES,"INPUT_TOO_LARGE");
      const buffer = Buffer.alloc(OTA_ASSET_MAX_BYTES+1); let length=0;
      while (length<buffer.length) {
        const {bytesRead} = await file.read(buffer,length,Math.min(64*1024,buffer.length-length),null);
        if (!bytesRead) break; length+=bytesRead;
      }
      ensure(length<=OTA_ASSET_MAX_BYTES,"INPUT_TOO_LARGE"); ensure(length>0);
      return buffer.subarray(0,length);
    } finally { await file.close(); }
  } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError("INVALID_INPUT"); }
}
function otaOrigin(value: string): string {
  try {
    const url = new URL(value);
    ensure(!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==="/"&&
      (url.protocol==="https:"||url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname)),"PROVIDER_UNCONFIGURED");
    return url.origin;
  } catch { throw new DomainError("PROVIDER_UNCONFIGURED"); }
}

export async function runDogfoodCommand(args: readonly string[], io: Pick<CliIO, "stdout" | "stderr">): Promise<number> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) { io.stdout(help); return 0; }
  const command = parse(args);
  if (!command) { io.stderr("USAGE_ERROR\n" + help); return 2; }

  // Read the bounded input before creating/opening/migrating any database.
  const bytes = command.file ? await (command.name === "ota-upload" ? readOTAFile(command.file) : readDogfoodInputFile(command.file)) : null;
  if (command.name === "import-source") await parseSourceBundle(bytes!, Date.now());
  const registration = command.name === "register-app" ? parseApplicationRegistration(parseJson(bytes!)) : null;
  const settings = command.name === "settings" ? parseSettingsUpdate(parseJson(bytes!)) : null;
  const connection = command.name === "github-connect" ? parseGitHubConnectionUpdate(parseJson(bytes!)) : null;
  const upload = command.name === "ota-upload" ? parseOTAAssetUpload({ key:command.assetKey,contentType:command.contentType,fileExtension:command.fileExtension }) : null;
  const publication = command.name === "ota-publish" ? parseOTAPublishInput(parseJson(bytes!)) : null;
  const enrollment = command.name === "runner-enroll" ? parseRunnerEnrollmentInput(parseJson(bytes!)) : null;
  const queuedJob = command.name === "automation-queue" ? parseAutomationQueueInput(parseJson(bytes!)) : null;
  const policy = command.name === "automation-policy" ? parseAutoPolicyUpdate(parseJson(bytes!)) : null;
  const resolvedConfig = command.resolvedConfigFile ? parseJson(await readDogfoodInputFile(command.resolvedConfigFile)) : undefined;
  if (resolvedConfig !== undefined) { safeJson(resolvedConfig); ensure(resolvedConfig !== null&&typeof resolvedConfig==="object"&&!Array.isArray(resolvedConfig)); }
  const needsOperations = ["serve","github-connect","ota-upload","ota-publish","operations"].includes(command.name) || automationCommands.includes(command.name);
  const githubAppId = needsOperations ? process.env.FLORA_GITHUB_APP_ID : undefined;
  const githubPrivateKey = needsOperations ? process.env.FLORA_GITHUB_PRIVATE_KEY : undefined;
  ensure(Boolean(githubAppId)===Boolean(githubPrivateKey),"PROVIDER_UNCONFIGURED");
  if (command.name === "github-connect") ensure(githubAppId&&githubPrivateKey,"PROVIDER_UNCONFIGURED");
  const github = githubAppId&&githubPrivateKey ? createGitHubResolver({credentials:{appId:githubAppId,privateKey:githubPrivateKey}}) : undefined;
  const automationSource = githubAppId&&githubPrivateKey ? createGitHubAutomationSourceProvider({credentials:{appId:githubAppId,privateKey:githubPrivateKey}}) : undefined;
  const githubWebhookSecret = command.name === "serve" ? process.env.FLORA_GITHUB_WEBHOOK_SECRET : undefined;
  if (githubWebhookSecret!==undefined) ensure(githubWebhookSecret.length>0&&githubWebhookSecret.length<=4096,"PROVIDER_UNCONFIGURED");
  const signingKey = needsOperations ? process.env.FLORA_OTA_SIGNING_PRIVATE_KEY : undefined;
  const signingId = needsOperations ? process.env.FLORA_OTA_SIGNING_KEY_ID : undefined;
  ensure(Boolean(signingKey) === Boolean(signingId), "PROVIDER_UNCONFIGURED");
  const signer = signingKey && signingId ? createRSAManifestSigner({ privateKey: signingKey, keyId: signingId }) : undefined;
  const configuredOrigin = needsOperations&&process.env.FLORA_OTA_ORIGIN ? otaOrigin(process.env.FLORA_OTA_ORIGIN) : undefined;
  if (command.name === "ota-publish" || automationCommands.includes(command.name)) ensure(configuredOrigin,"PROVIDER_UNCONFIGURED");
  let serverOrigin = "";
  const dbPath = await preparePrivateStore(command.dbPath);
  await verifyPrivateStore(dbPath);
  const db = openDatabase(dbPath);
  let service: Awaited<ReturnType<typeof createDogfoodService>> | null = null;
  let server: { close(): Promise<void> } | null = null;
  let ownedNonce: string | null = null;
  let signal: (() => void) | null = null;
  try {
    migrate(db); await verifyPrivateStore(dbPath);
    if (command.name === "serve") {
      const nonce = randomUUID();
      acquireDashboardOwner(db, { nonce, pid: process.pid, host: hostname() });
      ownedNonce = nonce;
      interruptVerifications(db, Date.now());
    }
    const store = createSqliteDogfoodStore(db);
    service = await createDogfoodService(store, [createBlockedProvider()], Date.now, { ...(github ? { github } : {}), ...(automationSource ? { automationSource } : {}), ...(signer ? { signer } : {}), ...(command.name === "serve" ? { publicOrigin: () => serverOrigin } : configuredOrigin ? { publicOrigin: configuredOrigin } : {}) });
    if (command.name === "serve") {
      const stopped = new Promise<void>(resolve => { signal = resolve; });
      process.on("SIGINT", signal!); process.on("SIGTERM", signal!);
      // Only the local serve path loads the Node HTTP adapter.
      const { startDashboard } = await import("@app-ops/dashboard");
      const app = await startDashboard({ service, ...(githubWebhookSecret ? { githubWebhookSecret } : {}), ...(command.port === undefined ? {} : { port: command.port }) });
      server = app; serverOrigin = app.origin;
      await verifyPrivateStore(dbPath);
      io.stdout(app.bootstrapUrl + "\n");
      await stopped;
      return 0;
    }
    let output: unknown;
    if (command.name === "runner-enroll") {
      ensure(enrollment&&service.automation,"PROVIDER_UNSUPPORTED"); output = await service.automation.enrollRunner(enrollment);
    } else if (command.name === "runner-revoke") {
      ensure(service.automation,"PROVIDER_UNSUPPORTED"); output = await service.automation.revokeRunner(command.runnerId!);
    } else if (command.name === "automation-queue") {
      ensure(queuedJob&&service.automation,"PROVIDER_UNSUPPORTED"); output = await service.automation.queue(command.appId!,queuedJob);
    } else if (command.name === "automation-policy") {
      ensure(policy&&service.automation,"PROVIDER_UNSUPPORTED"); output = await service.automation.updatePolicy(command.appId!,policy);
    } else if (command.name === "automation-cancel") {
      ensure(service.automation,"PROVIDER_UNSUPPORTED"); output = await service.automation.cancel(command.appId!,command.jobId!);
    } else if (command.name === "automation") {
      ensure(service.automation,"PROVIDER_UNSUPPORTED"); output = await service.automation.getState(command.appId!);
    } else if (command.name === "github-connect") {
      ensure(connection&&service.operations,"PROVIDER_UNSUPPORTED");
      output = await service.operations.connect(command.appId!,connection,resolvedConfig);
    } else if (command.name === "ota-upload") {
      ensure(upload&&service.operations,"PROVIDER_UNSUPPORTED");
      output = await service.operations.uploadAsset(command.appId!,upload,bytes!);
    } else if (command.name === "ota-publish") {
      ensure(publication&&service.operations,"PROVIDER_UNSUPPORTED");
      output = await service.operations.publish(command.appId!,publication);
    } else if (command.name === "operations") {
      ensure(service.operations,"PROVIDER_UNSUPPORTED");
      output = await service.operations.getState(command.appId!);
    } else if (command.name === "register-app") {
      ensure(registration && service.registerApplication, "PROVIDER_UNSUPPORTED");
      output = await service.registerApplication(registration);
    } else if (command.name === "settings") {
      ensure(settings && service.updateApplicationSettings, "PROVIDER_UNSUPPORTED");
      output = await service.updateApplicationSettings(command.appId!, settings);
    } else if (command.name === "import-source") {
      const saved = await service.importSource(bytes!, command.appId);
      const app = await store.applications?.getApplicationForSnapshot(saved.id);
      output = { ...(app ? { appId: app.id } : {}), snapshotId: saved.id, digest: saved.digest, evidenceOrigin: saved.evidenceOrigin, connection: saved.connection };
    } else if (command.name === "import-baseline") {
      const record = await service.importBaseline(command.snapshotId!, bytes!, command.appId);
      const app = await store.applications?.getApplicationForSnapshot(record.snapshotId);
      output = { ...(app ? { appId: app.id } : {}), verificationId: record.id, snapshotId: record.snapshotId, state: record.state,
        evidenceKind: record.evidenceKind, evidenceOrigin: record.evidenceOrigin, assessment: record.assessment };
    } else output = await service.getState(undefined, command.appId);
    await verifyPrivateStore(dbPath);
    io.stdout(JSON.stringify(output) + "\n");
    return 0;
  } finally {
    try { if (service) await service.close(); }
    finally {
      try { if (server) await server.close(); }
      finally {
        try {
          if (ownedNonce !== null) releaseDashboardOwner(db, ownedNonce);
          await verifyPrivateStore(dbPath);
        } finally {
          db.close();
          if (signal) { process.off("SIGINT", signal); process.off("SIGTERM", signal); }
        }
      }
    }
  }
}
