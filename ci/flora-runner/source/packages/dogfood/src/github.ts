import { DomainError, ensure, integer, object, safeJson, text } from "@app-ops/core";
import { freeze } from "@app-ops/config";
import { parseGitHubConnectionUpdate } from "./operations.js";
import type { GitHubConnection, GitHubDetectionResult, GitHubResolver, OTAPlatform } from "./operations.js";
import { parseFloraConfig } from "./automation.js";
import type { AutomationSourceProvider } from "./automation.js";

export interface GitHubAppCredentials { appId: string; privateKey: string }
/** Installation tokens are opaque. GitHub's 2026 stateless tokens contain JWT
 * dots and may exceed the legacy size. RFC 6750 bearer characters remain safe
 * in headers; the independent bound rejects oversized provider credentials. */
export function isGitHubInstallationToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 4096 && /^[A-Za-z0-9._~+/-]+=*$/.test(value);
}
function installationToken(value: unknown): string {
  ensure(isGitHubInstallationToken(value), "PROVIDER_UNSUPPORTED"); return value;
}
export interface GitHubResolverOptions {
  credentials: GitHubAppCredentials | (() => Promise<GitHubAppCredentials>);
  fetch?: typeof fetch;
  now?: () => number;
  /** May only lower the production 30-second aggregate deadline. */
  timeoutMs?: number;
  /** Trusted server admission hook, called only after guarded ref validation. */
  onCurrentRefValidated?: (connection: GitHubConnection, commitSha: string) => void;
}
const fileLimit = 256 * 1024, responseLimit = 1024 * 1024;
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const utf8 = new TextEncoder();
function der(tag: number, bytes: Uint8Array): Uint8Array {
  const size: number[] = []; let length = bytes.length;
  do { size.unshift(length & 255); length >>>= 8; } while (length);
  return Uint8Array.from([tag, ...(bytes.length < 128 ? [bytes.length] : [128 | size.length, ...size]), ...bytes]);
}
/** GitHub downloads RSA PKCS#1 keys; Web Crypto requires the PKCS#8 envelope. */
export async function importRSAPrivateKey(pem: string): Promise<CryptoKey> {
  ensure(typeof pem === "string" && pem.length <= 16_384, "PROVIDER_UNCONFIGURED");
  const match = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\s+([A-Za-z0-9+/=\s]+)-----END \1-----\s*$/.exec(pem);
  ensure(match, "PROVIDER_UNCONFIGURED");
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(match[2]!.replace(/\s/g, "")), value => value.charCodeAt(0)); }
  catch { throw new DomainError("PROVIDER_UNCONFIGURED"); }
  if (match[1] === "RSA PRIVATE KEY") {
    const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
    bytes = der(0x30, Uint8Array.from([0x02, 0x01, 0x00, ...algorithm, ...der(0x04, bytes)]));
  }
  try { return await crypto.subtle.importKey("pkcs8", new Uint8Array(bytes).buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]); }
  catch { throw new DomainError("PROVIDER_UNCONFIGURED"); }
}
export async function createGitHubAppJWT(credentials: GitHubAppCredentials, now: number): Promise<string> {
  const issuer = text(credentials.appId, 128); ensure(/^[A-Za-z0-9_.-]+$/.test(issuer), "PROVIDER_UNCONFIGURED");
  const time = Math.floor(now / 1000);
  const message = encode(utf8.encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))) + "." + encode(utf8.encode(JSON.stringify({ iat: time - 60, exp: time + 540, iss: issuer })));
  const key = await importRSAPrivateKey(credentials.privateKey);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8.encode(message));
  return message + "." + encode(new Uint8Array(signature));
}
function parse(bytes: Uint8Array): unknown {
  try { const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); safeJson(value); return value; }
  catch { throw new DomainError("PROVIDER_UNSUPPORTED"); }
}
function record(value: unknown): Record<string, unknown> { ensure(value !== null && typeof value === "object" && !Array.isArray(value), "PROVIDER_UNSUPPORTED"); return value as Record<string, unknown>; }
function dependency(pack: Record<string, unknown>, name: string): string | null {
  for (const field of ["dependencies", "devDependencies"]) {
    const dependencies = pack[field];
    if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      const value = (dependencies as Record<string, unknown>)[name];
      if (typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value)) return value;
    }
  }
  return null;
}
function result(pack: Record<string, unknown>, config: Record<string, unknown> | null, configSource: GitHubDetectionResult["configSource"], commitSha: string): GitHubDetectionResult {
  const expoVersion = dependency(pack, "expo"), reactNativeVersion = dependency(pack, "react-native");
  const framework = expoVersion ? "expo" : reactNativeVersion ? "react-native" : "unsupported";
  const reasons: string[] = [];
  const runtimeVersion = typeof config?.runtimeVersion === "string" && config.runtimeVersion.length <= 128 && config.runtimeVersion.length > 0 && !/[\u0000-\u001f\u007f]/.test(config.runtimeVersion) ? config.runtimeVersion : null;
  const declaredPlatforms = config?.platforms;
  const platforms: OTAPlatform[] = declaredPlatforms === undefined ? ["ios", "android"] : Array.isArray(declaredPlatforms) ? ["ios", "android"].filter(platform => declaredPlatforms.includes(platform)) as OTAPlatform[] : [];
  const updates = config?.updates && typeof config.updates === "object" && !Array.isArray(config.updates) ? config.updates as Record<string, unknown> : {};
  let updatesUrl: string | null = null;
  if (typeof updates.url === "string" && updates.url.length <= 2048) {
    try { const url = new URL(updates.url); if (!url.username && !url.password && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) updatesUrl = url.href; } catch { /* Unsupported declared URL is not a capability. */ }
  }
  if (framework === "unsupported") reasons.push("NOT_EXPO_OR_REACT_NATIVE");
  if (!dependency(pack, "expo-updates")) reasons.push("EXPO_UPDATES_DEPENDENCY_MISSING");
  if (configSource === "dynamic-required") reasons.push("RESOLVED_CONFIG_EXPORT_REQUIRED");
  else if (!config) reasons.push("EXPO_CONFIG_MISSING");
  if (!runtimeVersion) reasons.push("EXPLICIT_RUNTIME_VERSION_REQUIRED");
  if (!updatesUrl || updates.enabled !== undefined && updates.enabled !== true) reasons.push("EXPO_UPDATES_CONFIGURATION_REQUIRED");
  if (!platforms.length) reasons.push("NATIVE_PLATFORM_REQUIRED");
  // One summary cannot safely represent differing native compatibility. Even
  // operator exports must resolve platform policies to matching explicit values.
  const unresolved = ["ios", "android"].some(platform => {
    const declared = config?.[platform]; if (declared === undefined) return false;
    if (!declared || typeof declared !== "object" || Array.isArray(declared)) return true;
    const native = declared as Record<string, unknown>;
    if (native.runtimeVersion !== undefined && native.runtimeVersion !== runtimeVersion) return true;
    if (native.updates !== undefined) {
      if (!native.updates || typeof native.updates !== "object" || Array.isArray(native.updates)) return true;
      const override = native.updates as Record<string, unknown>;
      if (override.enabled !== undefined && override.enabled !== (updates.enabled ?? true)) return true;
      if (override.url !== undefined) { try { if (typeof override.url !== "string" || new URL(override.url).href !== updatesUrl) return true; } catch { return true; } }
    }
    return false;
  });
  if (unresolved) reasons.push("PLATFORM_RUNTIME_UNRESOLVED");
  return freeze({ commitSha, framework, expoVersion, reactNativeVersion, configSource, runtimeVersion, platforms, updatesEnabled: reasons.length === 0, updatesUrl, reasons });
}
/** Fixed GitHub REST origin, least-privilege installation token, 30s aggregate
 * detection deadline, 10s/request, <=1MiB JSON and <=256KiB decoded files.
 * Only package.json and static app/Flora JSON are read. Config JS/TS is never evaluated.
 * Push detection checks the configured ref before and after those pinned reads. */
export function createGitHubResolver(options: GitHubResolverOptions): GitHubResolver {
  const request = options.fetch ?? fetch, now = options.now ?? Date.now;
  return {
    async detect(connection, rootDirectory, resolvedConfig, requireCommitSha) {
      const timeoutMs = options.timeoutMs ?? 30_000;
      ensure(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000);
      const overall = new AbortController(); let overallTimer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => { overallTimer = setTimeout(() => { overall.abort(); reject(new DomainError("PROVIDER_UNSUPPORTED")); }, timeoutMs); });
      const perform = async (): Promise<GitHubDetectionResult> => {
      parseGitHubConnectionUpdate({ expectedVersion: connection.version - 1, installationId: connection.installationId, owner: connection.owner, repository: connection.repository, ref: connection.ref });
      ensure(rootDirectory === "." || rootDirectory.length <= 4096 && !/[\\:\u0000-\u001f\u007f]/.test(rootDirectory) && rootDirectory.split("/").every(part => part !== "" && ![".", "..", "__proto__", "constructor", "prototype"].includes(part)));
      const deadline = now() + timeoutMs;
      async function json(path: string, authorization: string, method = "GET", body?: string): Promise<unknown> {
        const duration = Math.min(10_000, deadline - now()); ensure(duration > 0 && !overall.signal.aborted, "PROVIDER_UNSUPPORTED");
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), duration);
        const abort = () => controller.abort(); overall.signal.addEventListener("abort", abort, { once: true });
        let interrupt!: () => void;
        const interrupted = new Promise<never>((_, reject) => { interrupt = () => reject(new DomainError("PROVIDER_UNSUPPORTED")); controller.signal.addEventListener("abort", interrupt, { once: true }); });
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, response: Response | undefined;
        try {
          response = await Promise.race([request("https://api.github.com" + path, { method, redirect: "manual", signal: controller.signal,
            headers: { Authorization: "Bearer " + authorization, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "flora-app-operations", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body }) }), interrupted]);
          ensure(response.status === 200 || method === "POST" && response.status === 201, "PROVIDER_UNSUPPORTED");
          const declared = response.headers.get("Content-Length"); if (declared !== null) ensure(/^\d+$/.test(declared) && Number(declared) <= responseLimit, "PROVIDER_UNSUPPORTED");
          ensure(response.body, "PROVIDER_UNSUPPORTED"); reader = response.body.getReader();
          const chunks: Uint8Array[] = []; let size = 0;
          for (;;) { const part = await Promise.race([reader.read(), interrupted]); if (part.done) break; size += part.value.byteLength; ensure(size <= responseLimit, "PROVIDER_UNSUPPORTED"); if (part.value.byteLength) chunks.push(part.value); }
          const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          return parse(bytes);
        } catch { throw new DomainError("PROVIDER_UNSUPPORTED"); }
        finally { clearTimeout(timer); overall.signal.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", interrupt); controller.abort(); if (reader) void reader.cancel().catch(() => {}); else void response?.body?.cancel().catch(() => {}); }
      }
      let credentials: GitHubAppCredentials;
      try { credentials = typeof options.credentials === "function" ? await options.credentials() : options.credentials; }
      catch { throw new DomainError("PROVIDER_UNCONFIGURED"); }
      const jwt = await createGitHubAppJWT(credentials, now());
      const grant = record(await json(`/app/installations/${connection.installationId}/access_tokens`, jwt, "POST", JSON.stringify({ repositories: [connection.repository], permissions: { contents: "read" } })));
      const token = installationToken(grant.token);
      const base = `/repos/${encodeURIComponent(connection.owner)}/${encodeURIComponent(connection.repository)}`;
      const commit = record(await json(base + "/commits/" + encodeURIComponent(connection.ref), token));
      const commitSha = text(commit.sha, 40); ensure(/^[a-f0-9]{40}$/.test(commitSha), "PROVIDER_UNSUPPORTED");
      if (requireCommitSha !== undefined) ensure(requireCommitSha === commitSha, "CONFIG_CONFLICT");
      if (requireCommitSha !== undefined) options.onCurrentRefValidated?.(connection, commitSha);
      async function checked(detected: GitHubDetectionResult): Promise<GitHubDetectionResult> {
        if (requireCommitSha !== undefined) {
          const current = record(await json(base + "/commits/" + encodeURIComponent(connection.ref), token));
          const currentSha = text(current.sha, 40); ensure(/^[a-f0-9]{40}$/.test(currentSha), "PROVIDER_UNSUPPORTED");
          ensure(currentSha === commitSha, "CONFIG_CONFLICT");
        }
        return detected;
      }
      const root = rootDirectory === "." ? "" : "/" + rootDirectory.split("/").map(encodeURIComponent).join("/");
      const listing = await json(base + "/contents" + root + "?ref=" + commitSha, token);
      ensure(Array.isArray(listing) && listing.length < 1000, "PROVIDER_UNSUPPORTED");
      const files = new Set(listing.filter(entry => entry && typeof entry === "object" && !Array.isArray(entry) && entry.type === "file").map(entry => entry.name));
      async function read(name: string): Promise<Record<string, unknown>> {
        const envelope = record(await json(base + "/contents" + root + "/" + name + "?ref=" + commitSha, token));
        ensure(envelope.type === "file" && envelope.encoding === "base64" && typeof envelope.size === "number" && Number.isSafeInteger(envelope.size) && envelope.size > 0 && envelope.size <= fileLimit, "PROVIDER_UNSUPPORTED");
        const content = text(envelope.content, responseLimit).replace(/\s/g, ""); ensure(/^[A-Za-z0-9+/]*={0,2}$/.test(content), "PROVIDER_UNSUPPORTED");
        let bytes: Uint8Array; try { bytes = Uint8Array.from(atob(content), value => value.charCodeAt(0)); } catch { throw new DomainError("PROVIDER_UNSUPPORTED"); }
        ensure(bytes.length === envelope.size && bytes.length <= fileLimit, "PROVIDER_UNSUPPORTED"); return record(parse(bytes));
      }
      ensure(files.has("package.json"), "PROVIDER_UNSUPPORTED"); const pack = await read("package.json");
      if (files.has("flora.config.json")) {
        const config = parseFloraConfig(await read("flora.config.json"));
        const expoVersion = dependency(pack, "expo"), reactNativeVersion = dependency(pack, "react-native"), sdk = dependency(pack, "@flora/ota");
        const reasons = sdk ? [] : ["FLORA_SDK_DEPENDENCY_MISSING"];
        return checked(freeze({ commitSha, framework: expoVersion ? "expo" : reactNativeVersion ? "react-native" : "flora", expoVersion, reactNativeVersion, configSource: "flora.config.json", runtimeVersion: config.runtimeVersion, platforms: config.platforms, updatesEnabled: reasons.length === 0, updatesUrl: config.updatesUrl, reasons, automationConfig: config }));
      }
      const dynamic = ["app.config.js", "app.config.ts", "app.config.mjs", "app.config.cjs"].some(name => files.has(name));
      if (resolvedConfig !== undefined) {
        const exported = object(resolvedConfig, ["commitSha", "config"]); ensure(exported.commitSha === commitSha, "CONFIG_CONFLICT");
        ensure(utf8.encode(JSON.stringify(exported.config)).length <= fileLimit, "INPUT_TOO_LARGE");
        const raw = record(exported.config); return checked(result(pack, record(raw.expo ?? raw), "resolved-export", commitSha));
      }
      if (dynamic) return checked(result(pack, null, "dynamic-required", commitSha));
      if (!files.has("app.json")) return checked(result(pack, null, "none", commitSha));
      const raw = await read("app.json"); return checked(result(pack, record(raw.expo ?? raw), "app.json", commitSha));
      };
      try { return await Promise.race([perform(), expired]); }
      finally { clearTimeout(overallTimer); overall.abort(); }
    },
  };
}
/** Used only after current Runner lease authorization. The read-only token is
 * delivered to the trusted Runner host, never its source/export subprocess. */
export function createGitHubAutomationSourceProvider(options: GitHubResolverOptions): AutomationSourceProvider {
  const request = options.fetch ?? fetch, now = options.now ?? Date.now;
  return {
    async grant(connection, commitSha, expiresAt) {
      parseGitHubConnectionUpdate({ expectedVersion: connection.version - 1, installationId: connection.installationId, owner: connection.owner, repository: connection.repository, ref: connection.ref });
      ensure(/^[a-f0-9]{40}$/.test(commitSha)); integer(expiresAt, now() + 1);
      const duration = Math.min(options.timeoutMs ?? 10_000, 10_000, expiresAt - now()); ensure(duration > 0);
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, response: Response | undefined;
      const interrupted = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new DomainError("PROVIDER_UNSUPPORTED")); }, duration); });
      const perform = async () => {
        let credentials: GitHubAppCredentials;
        try { credentials = typeof options.credentials === "function" ? await options.credentials() : options.credentials; } catch { throw new DomainError("PROVIDER_UNCONFIGURED"); }
        const jwt = await createGitHubAppJWT(credentials, now()); ensure(!controller.signal.aborted, "PROVIDER_UNSUPPORTED");
        response = await Promise.race([request(`https://api.github.com/app/installations/${connection.installationId}/access_tokens`, { method: "POST", redirect: "manual", signal: controller.signal, headers: { Authorization: "Bearer " + jwt, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "flora-app-operations" }, body: JSON.stringify({ repositories: [connection.repository], permissions: { contents: "read" } }) }), interrupted]);
        ensure(response.status === 201 || response.status === 200, "PROVIDER_UNSUPPORTED");
        const declared = response.headers.get("Content-Length"); if (declared !== null) ensure(/^\d+$/.test(declared) && Number(declared) <= 65_536, "PROVIDER_UNSUPPORTED");
        ensure(response.body, "PROVIDER_UNSUPPORTED"); reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) { const part = await Promise.race([reader.read(), interrupted]); if (part.done) break; size += part.value.byteLength; ensure(size <= 65_536, "PROVIDER_UNSUPPORTED"); if (part.value.byteLength) chunks.push(part.value); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const value = record(parse(bytes)), token = installationToken(value.token);
        ensure(typeof value.expires_at === "string", "PROVIDER_UNSUPPORTED"); const tokenExpiresAt = Date.parse(value.expires_at); ensure(Number.isSafeInteger(tokenExpiresAt) && tokenExpiresAt > now(), "PROVIDER_UNSUPPORTED");
        return freeze({ url: `https://api.github.com/repos/${encodeURIComponent(connection.owner)}/${encodeURIComponent(connection.repository)}/tarball/${commitSha}`, token, commitSha, expiresAt: Math.min(expiresAt, tokenExpiresAt), maxBytes: 64 * 1024 * 1024 });
      };
      try { return await Promise.race([perform(), interrupted]); }
      catch (error) { if (error instanceof DomainError && error.code === "PROVIDER_UNCONFIGURED") throw error; throw new DomainError("PROVIDER_UNSUPPORTED"); }
      finally { clearTimeout(timer); controller.abort(); if (reader) void reader.cancel().catch(() => {}); else void response?.body?.cancel().catch(() => {}); }
    },
  };
}
