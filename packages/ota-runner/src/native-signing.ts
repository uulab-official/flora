/**
 * Trusted final signing only. Compile app source before fetching these inputs.
 * The controller must move unsigned products into a canonical protected
 * namespace denied to all compiler descendants before invoking this module.
 * The filesystem checks below complement that boundary; path-based traversal
 * alone does not sandbox a hostile process concurrently mutating ancestors.
 * Passwords are never argv values and child output is never a diagnostic log.
 * Credentials live in a new private job directory and are removed in finally.
 * The host user/admin can still access its own processes: this is not a sandbox
 * for an actively hostile process already running as the Runner's OS account.
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { trustedProcess, processEnvironment } from "./process.js";

const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const SAFE_CODES = new Set(["SIGNING_CREDENTIAL_INVALID", "SIGNING_IDENTITY_INVALID", "SIGNING_PROFILE_INVALID", "SIGNING_ENTITLEMENTS_INVALID",
  "SIGNING_ARTIFACT_INVALID", "SIGNING_PATH_INVALID", "SIGNING_TOOL_FAILED", "SIGNING_CANCELLED", "SIGNING_CLEANUP_UNCONFIRMED", "SIGNING_FAILED"]);
const SIGNING_OPERATIONS = ["tool-execution", "keystore-validation", "certificate-decode", "private-key-decode", "profile-roots", "profile-cms-verify", "profile-cms-decode", "profile-field",
  "app-identity-metadata", "app-platform-metadata", "executable-metadata", "keychain-create", "keychain-unlock", "keychain-import", "keychain-access", "keychain-delete",
  "entitlements-convert", "framework-sign", "app-sign", "signature-verify", "signature-entitlements", "signature-certificate", "android-package-metadata", "android-align", "android-sign"] as const;
export type SigningOperation = typeof SIGNING_OPERATIONS[number];
export interface NativeSigningDiagnostic { diagnostic: true; stage: "native-signing"; operation: SigningOperation; state: "started" | "succeeded" | "failed"; code?: string }
export class NativeSigningFailure extends Error {
  readonly operation: SigningOperation;
  constructor(code: string, operation: SigningOperation) { super(SAFE_CODES.has(code) ? code : "SIGNING_TOOL_FAILED"); this.operation = SIGNING_OPERATIONS.includes(operation) ? operation : "tool-execution"; }
}
function fail(code: string): never { throw new Error(SAFE_CODES.has(code) ? code : "SIGNING_FAILED"); }
function requireValue(value: unknown, code = "SIGNING_CREDENTIAL_INVALID"): asserts value { if (!value) fail(code); }
function cancelled(signal?: AbortSignal) { if (signal?.aborted) fail("SIGNING_CANCELLED"); }
function fingerprint(value: string): string { const normalized = value.replace(/:/g, "").toLowerCase(); requireValue(/^[a-f0-9]{64}$/.test(normalized)); return normalized; }
function identifier(value: string) { requireValue(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(value) && value.length <= 255); }
function publicName(value: string) { requireValue(/^[A-Za-z0-9_-]{1,128}$/.test(value)); }
function secret(value: unknown): asserts value is string { requireValue(typeof value === "string" && value.length <= 1024 && !/[\r\n\0]/.test(value)); }
function bytes(input: string): Buffer {
  requireValue(typeof input === "string" && input.length > 0 && input.length <= Math.ceil(MAX_CREDENTIAL_BYTES / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input));
  const decoded = Buffer.from(input, "base64"); requireValue(decoded.length > 0 && decoded.length <= MAX_CREDENTIAL_BYTES && decoded.toString("base64") === input); return decoded;
}
function safeFailure(error: unknown, signal?: AbortSignal): Error {
  const message = signal?.aborted ? "SIGNING_CANCELLED" : error instanceof Error && SAFE_CODES.has(error.message) ? error.message : "SIGNING_TOOL_FAILED";
  return error instanceof NativeSigningFailure ? new NativeSigningFailure(message, error.operation) : new Error(message);
}
function sha256(input: Uint8Array): string { return createHash("sha256").update(input).digest("hex"); }
function certSummary(cert: X509Certificate, applicationId: string) {
  const now = Date.now(), start = Date.parse(cert.validFrom), expiry = Date.parse(cert.validTo);
  requireValue(Number.isFinite(start) && Number.isFinite(expiry) && start <= now && expiry > now, "SIGNING_IDENTITY_INVALID");
  const details = cert.publicKey.asymmetricKeyDetails;
  requireValue(cert.publicKey.asymmetricKeyType === "rsa" && (details?.modulusLength ?? 0) >= 2048 ||
    cert.publicKey.asymmetricKeyType === "ec" && ["prime256v1", "secp384r1"].includes(details?.namedCurve ?? ""), "SIGNING_IDENTITY_INVALID");
  return { applicationId, certificateSha256: sha256(cert.raw), certificateSha1: createHash("sha1").update(cert.raw).digest("hex"), expiresAt: new Date(expiry).toISOString() };
}

export interface CredentialFile { fileBase64: string }
export interface PasswordCredential extends CredentialFile { password: string }
export interface AndroidSigningCredential extends PasswordCredential { keyAlias: string; keyPassword?: string }
export interface NativeSigningSummary { applicationId: string; certificateSha256: string; certificateSha1: string; expiresAt: string }
export interface NativeSigningReceipt extends NativeSigningSummary { platform: "ios" | "android"; artifactPath: string; artifactSha256: string; profileUuid?: string }
export interface SigningTools { openssl?: string; keytool?: string; security?: string; plutil?: string; codesign?: string; aapt2?: string; apksigner?: string; zipalign?: string }
export interface SigningJobContext { jobId: string; appId: string; applicationId: string; expectedCertificateSha256: string; temporaryRoot?: string; signal?: AbortSignal; tools?: SigningTools; onDiagnostic?: (event: NativeSigningDiagnostic) => void | Promise<void> }
export interface AndroidSigningInput extends SigningJobContext { credential: AndroidSigningCredential }
export interface IOSSigningInput extends SigningJobContext { teamId: string; certificate: PasswordCredential; provisioning: CredentialFile }
export interface PrivateSigningDirectory { path: string; write(name: string, contents: Uint8Array | string): Promise<string> }
export interface IOSProvisioningProfile {
  uuid: string; teamIdentifiers: string[]; prefixes: string[]; applicationIdentifier: string; expiresAt: string;
  developerCertificates: string[]; platform: string; entitlements: Record<string, unknown>;
}
export interface IOSSigningSummary extends NativeSigningSummary { teamId: string; profileUuid: string; profileExpiresAt: string }
export interface AndroidSigningMaterial { directory: string; keystorePath: string; summary: NativeSigningSummary }
export interface IOSSigningMaterial { directory: string; keychainPath: string; provisioningPath: string; profile: IOSProvisioningProfile; summary: IOSSigningSummary }

/** New directory only; never delete or chmod an existing user's credential path. */
export async function withPrivateSigningDirectory<T>(context: { jobId: string; appId: string; temporaryRoot?: string }, use: (directory: PrivateSigningDirectory) => Promise<T>): Promise<T> {
  publicName(context.jobId); publicName(context.appId);
  const parent = context.temporaryRoot ?? tmpdir(); requireValue(isAbsolute(parent), "SIGNING_PATH_INVALID");
  const parentStat = await lstat(parent); requireValue(parentStat.isDirectory() && !parentStat.isSymbolicLink(), "SIGNING_PATH_INVALID");
  const path = await mkdtemp(join(parent, "flora-native-signing-"));
  try {
    await chmod(path, 0o700);
    const directory: PrivateSigningDirectory = { path, write(name, contents) {
      requireValue(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && name !== "." && name !== "..", "SIGNING_PATH_INVALID");
      const target = join(path, name); return writeFile(target, contents, { flag: "wx", mode: 0o600 }).then(() => target);
    } };
    await directory.write("owner.json", JSON.stringify({ jobId: context.jobId, appId: context.appId, pid: process.pid, startedAt: Date.now() }));
    return await use(directory);
  } finally {
    try { await rm(path, { recursive: true, force: true }); } catch { fail("SIGNING_CLEANUP_UNCONFIRMED"); }
    try { await lstat(path); fail("SIGNING_CLEANUP_UNCONFIRMED"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("SIGNING_CLEANUP_UNCONFIRMED"); }
  }
}
function validateContext(input: SigningJobContext) { publicName(input.jobId); publicName(input.appId); identifier(input.applicationId); fingerprint(input.expectedCertificateSha256); cancelled(input.signal); }
async function executable(path: string): Promise<string> {
  requireValue(isAbsolute(path) && !/[\r\n\0]/.test(path), "SIGNING_PATH_INVALID"); const resolved = await realpath(path), info = await stat(resolved);
  requireValue(info.isFile() && !!(info.mode & 0o111), "SIGNING_TOOL_FAILED"); return resolved;
}
function signingOperation(args: readonly string[]): SigningOperation {
  if (args.includes("-importkeystore")) return "keystore-validation";
  if (args[0] === "pkcs12") return args.includes("-nocerts") ? "private-key-decode" : "certificate-decode";
  if (args[0] === "find-certificate") return "profile-roots";
  if (args[0] === "cms") return args.includes("-verify") ? "profile-cms-verify" : "profile-cms-decode";
  if (args[0] === "-extract") return args[1] === "CFBundleIdentifier" ? "app-identity-metadata" : args[1] === "CFBundleSupportedPlatforms.0" ? "app-platform-metadata" : args[1] === "CFBundleExecutable" ? "executable-metadata" : "profile-field";
  if (args[0] === "create-keychain") return "keychain-create"; if (args[0] === "unlock-keychain") return "keychain-unlock";
  if (args[0] === "import") return "keychain-import"; if (args[0] === "set-key-partition-list") return "keychain-access"; if (args[0] === "delete-keychain") return "keychain-delete";
  if (args[0] === "-convert") return "entitlements-convert";
  if (args[0] === "--force") return args.includes("--entitlements") ? "app-sign" : "framework-sign";
  if (args[0] === "--verify" || args[0] === "verify") return "signature-verify";
  if (args[0] === "-d" && args[1] === "--entitlements") return "signature-entitlements";
  if (args[0] === "--display") return "signature-certificate";
  if (args[0] === "dump") return "android-package-metadata"; if (args[0] === "-p") return "android-align"; if (args[0] === "sign") return "android-sign";
  return "tool-execution";
}
function signingDiagnostic(input: SigningJobContext, operation: SigningOperation, state: NativeSigningDiagnostic["state"], code?: string): void {
  const event: NativeSigningDiagnostic = { diagnostic: true, stage: "native-signing", operation, state, ...(code && SAFE_CODES.has(code) ? { code } : {}) };
  // Diagnostics are opt-in and contain fixed fields only. A consumer failure
  // cannot prevent the finally cleanup from deleting a temporary keychain.
  try { const result = input.onDiagnostic?.(Object.freeze(event)); if (result) void result.catch(() => {}); } catch {}
}
async function command(tool: string, args: string[], input: SigningJobContext, options: { stdin?: string; env?: Record<string, string>; maxBytes?: number } = {}): Promise<string> {
  cancelled(input.signal); const operation = signingOperation(args); signingDiagnostic(input, operation, "started");
  try {
    const result = await trustedProcess(await executable(tool), args, { env: processEnvironment({ HOME: homedir(), LANG: "en_US.UTF-8", ...options.env }),
      ...(input.signal ? { signal: input.signal } : {}), timeoutMs: 120000, maxBytes: options.maxBytes ?? 2 * 1024 * 1024,
      ...(options.stdin !== undefined ? { input: options.stdin } : {}) });
    signingDiagnostic(input, operation, "succeeded"); return result;
  } catch (error) { const safe = safeFailure(error, input.signal); signingDiagnostic(input, operation, "failed", safe.message); throw new NativeSigningFailure(safe.message, operation); }
}
async function checkedPair(certificatePem: string, privateKeyPem: string, applicationId: string): Promise<NativeSigningSummary> {
  try {
    const certificates = certificatePem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    const keys = privateKeyPem.match(/-----BEGIN (?:RSA |EC |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |)PRIVATE KEY-----/g) ?? [];
    requireValue(certificates.length === 1 && keys.length === 1, "SIGNING_IDENTITY_INVALID");
    const cert = new X509Certificate(certificates[0]!), privateKey = createPrivateKey(keys[0]!);
    requireValue(cert.publicKey.export({ type: "spki", format: "der" }).equals(createPublicKey(privateKey).export({ type: "spki", format: "der" })), "SIGNING_IDENTITY_INVALID");
    return certSummary(cert, applicationId);
  } catch (error) { throw safeFailure(error); }
}

/** The CMS trust check happens before callers supply decoded fields to this validator. */
export function validateIOSIdentity(input: { certificatePem: string; privateKeyPem: string; profile: IOSProvisioningProfile; teamId: string; applicationId: string; expectedCertificateSha256: string }): IOSSigningSummary {
  try {
    identifier(input.applicationId); requireValue(/^[A-Z0-9]{10}$/.test(input.teamId), "SIGNING_IDENTITY_INVALID");
    const certs = input.certificatePem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    const keys = input.privateKeyPem.match(/-----BEGIN (?:RSA |EC |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |)PRIVATE KEY-----/g) ?? [];
    requireValue(certs.length === 1 && keys.length === 1, "SIGNING_IDENTITY_INVALID");
    const cert = new X509Certificate(certs[0]!), key = createPrivateKey(keys[0]!), summary = certSummary(cert, input.applicationId);
    requireValue(summary.certificateSha256 === fingerprint(input.expectedCertificateSha256) && cert.publicKey.export({ type: "spki", format: "der" }).equals(createPublicKey(key).export({ type: "spki", format: "der" })), "SIGNING_IDENTITY_INVALID");
    requireValue(cert.subject.split("\n").includes("OU=" + input.teamId) && cert.subject.split("\n").some(line => /^CN=(?:Apple Distribution|iPhone Distribution)\b/.test(line)), "SIGNING_IDENTITY_INVALID");
    const profile = input.profile, profileExpiry = Date.parse(profile.expiresAt);
    requireValue(profile.platform === "iOS" && /^[a-f0-9-]{36}$/i.test(profile.uuid) && profile.teamIdentifiers.length === 1 && profile.teamIdentifiers[0] === input.teamId &&
      profile.prefixes.length === 1 && /^[A-Z0-9]{10}$/.test(profile.prefixes[0]!) && Number.isFinite(profileExpiry) && profileExpiry > Date.now(), "SIGNING_PROFILE_INVALID");
    const exactIdentifier = profile.prefixes[0] + "." + input.applicationId;
    requireValue(profile.applicationIdentifier === exactIdentifier && profile.entitlements["application-identifier"] === exactIdentifier &&
      profile.entitlements["com.apple.developer.team-identifier"] === input.teamId && profile.entitlements["get-task-allow"] === false, "SIGNING_PROFILE_INVALID");
    requireValue(profile.developerCertificates.length > 0 && profile.developerCertificates.length <= 128 && profile.developerCertificates.some(value => sha256(Buffer.from(value, "base64")) === summary.certificateSha256), "SIGNING_PROFILE_INVALID");
    return { ...summary, teamId: input.teamId, profileUuid: profile.uuid, profileExpiresAt: new Date(profileExpiry).toISOString() };
  } catch (error) { throw safeFailure(error); }
}
function entitlementAllows(allowed: unknown, requested: unknown): boolean {
  if (typeof allowed === "string" && typeof requested === "string") return allowed === requested || allowed === "*" || allowed.endsWith("*") && requested.startsWith(allowed.slice(0, -1));
  if (Array.isArray(allowed) && Array.isArray(requested)) return requested.length <= 128 && requested.every(value => allowed.some(candidate => entitlementAllows(candidate, value)));
  return ["boolean", "number"].includes(typeof allowed) && allowed === requested;
}
function associatedDomains(value: unknown): asserts value is string[] {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 128, "SIGNING_ENTITLEMENTS_INVALID");
  // Only this entitlement treats the profile's scalar '*' as authorization for
  // an array. Do not generalize it to keychain groups or other capabilities.
  for (const item of value) {
    requireValue(typeof item === "string" && item.length <= 1024, "SIGNING_ENTITLEMENTS_INVALID");
    const domain = /^(?:applinks|webcredentials|activitycontinuation|appclips):((?:\*\.)?[a-z0-9.-]+)(?:\?mode=(?:developer|managed|developer\+managed))?$/.exec(item);
    requireValue(domain, "SIGNING_ENTITLEMENTS_INVALID"); const host = domain[1]!.replace(/^\*\./, ""), labels = host.split(".");
    requireValue(host.length <= 253 && labels.length >= 2 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)), "SIGNING_ENTITLEMENTS_INVALID");
  }
}
export function selectIOSEntitlements(profile: IOSProvisioningProfile, applicationId: string, teamId: string, requested: Record<string, unknown> = {}): Record<string, unknown> {
  identifier(applicationId); requireValue(profile.entitlements && typeof profile.entitlements === "object" && !Array.isArray(profile.entitlements), "SIGNING_ENTITLEMENTS_INVALID");
  requireValue(requested && typeof requested === "object" && !Array.isArray(requested) && Object.keys(requested).length <= 128, "SIGNING_ENTITLEMENTS_INVALID");
  const appIdentifier = profile.prefixes[0] + "." + applicationId;
  const defaults: Record<string, unknown> = { "application-identifier": appIdentifier, "com.apple.developer.team-identifier": teamId, "get-task-allow": false,
    "keychain-access-groups": [appIdentifier], ...(profile.entitlements["aps-environment"] ? { "aps-environment": profile.entitlements["aps-environment"] } : {}),
    ...(profile.entitlements["beta-reports-active"] === true ? { "beta-reports-active": true } : {}) };
  const entitlements = { ...defaults, ...requested };
  // Source projects commonly use the development APNs value. An App Store
  // profile authorizes the production value that the native export must use.
  if (Object.hasOwn(requested, "aps-environment")) {
    requireValue(requested["aps-environment"] === "development" || requested["aps-environment"] === "production", "SIGNING_ENTITLEMENTS_INVALID");
    if (requested["aps-environment"] === "development" && profile.entitlements["aps-environment"] === "production") {
      requireValue(profile.entitlements["get-task-allow"] === false && profile.entitlements["beta-reports-active"] === true, "SIGNING_ENTITLEMENTS_INVALID");
      entitlements["aps-environment"] = "production";
    }
  }
  requireValue(entitlements["application-identifier"] === appIdentifier && entitlements["com.apple.developer.team-identifier"] === teamId && entitlements["get-task-allow"] === false, "SIGNING_ENTITLEMENTS_INVALID");
  // A broad profile authorizes signing many apps; this grant authorizes one app.
  requireValue(Array.isArray(entitlements["keychain-access-groups"]) && entitlements["keychain-access-groups"].every(group => group === appIdentifier), "SIGNING_ENTITLEMENTS_INVALID");
  for (const [key, value] of Object.entries(entitlements)) {
    requireValue(Object.hasOwn(profile.entitlements, key), "SIGNING_ENTITLEMENTS_INVALID");
    if (key === "com.apple.developer.associated-domains") { associatedDomains(value); requireValue(profile.entitlements[key] === "*" || entitlementAllows(profile.entitlements[key], value), "SIGNING_ENTITLEMENTS_INVALID"); }
    else requireValue(entitlementAllows(profile.entitlements[key], value), "SIGNING_ENTITLEMENTS_INVALID");
  }
  return entitlements;
}

export async function withAndroidSigningMaterial<T>(input: AndroidSigningInput, use: (material: AndroidSigningMaterial) => Promise<T>): Promise<T> {
  validateContext(input); secret(input.credential.password); secret(input.credential.keyPassword ?? input.credential.password);
  requireValue(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(input.credential.keyAlias)); const payload = bytes(input.credential.fileBase64);
  return withPrivateSigningDirectory(input, async directory => {
    try {
      const keystorePath = await directory.write("signing.keystore", payload), converted = await directory.write("inspection.p12", Buffer.alloc(0));
      const inspectionPassword = randomBytes(32).toString("hex"), environment = { FLORA_SIGN_STORE_PASSWORD: input.credential.password,
        FLORA_SIGN_KEY_PASSWORD: input.credential.keyPassword ?? input.credential.password, FLORA_INSPECTION_PASSWORD: inspectionPassword };
      const keytool = input.tools?.keytool ?? "/usr/bin/keytool", openssl = input.tools?.openssl ?? "/usr/bin/openssl";
      // Importing the selected entry proves the private-key password, unlike -list.
      await rm(converted);
      await command(keytool, ["-J-Duser.language=en", "-J-Duser.country=US", "-importkeystore", "-srckeystore", keystorePath,
        "-srcalias", input.credential.keyAlias, "-srcstorepass:env", "FLORA_SIGN_STORE_PASSWORD", "-srckeypass:env", "FLORA_SIGN_KEY_PASSWORD",
        "-destkeystore", converted, "-deststoretype", "PKCS12", "-deststorepass:env", "FLORA_INSPECTION_PASSWORD", "-destkeypass:env", "FLORA_INSPECTION_PASSWORD", "-noprompt"], input, { env: environment });
      await chmod(converted, 0o600);
      const certificatePem = await command(openssl, ["pkcs12", "-in", converted, "-clcerts", "-nokeys", "-passin", "stdin"], input, { stdin: inspectionPassword + "\n" });
      const privateKeyPem = await command(openssl, ["pkcs12", "-in", converted, "-nocerts", "-nodes", "-passin", "stdin"], input, { stdin: inspectionPassword + "\n" });
      const summary = await checkedPair(certificatePem, privateKeyPem, input.applicationId);
      requireValue(summary.certificateSha256 === fingerprint(input.expectedCertificateSha256), "SIGNING_IDENTITY_INVALID");
      await rm(converted); cancelled(input.signal);
      return await use({ directory: directory.path, keystorePath, summary });
    } catch (error) { throw safeFailure(error, input.signal); } finally { payload.fill(0); }
  });
}

async function plistValue(path: string, key: string, format: "raw" | "json" | "xml1", input: SigningJobContext): Promise<string> {
  return command(input.tools?.plutil ?? "/usr/bin/plutil", ["-extract", key, format, "-o", "-", path], input);
}
async function profileFields(decoded: string, input: SigningJobContext): Promise<IOSProvisioningProfile> {
  const raw = async (key: string) => (await plistValue(decoded, key, "raw", input)).trim();
  const array = async (key: string) => { const count = Number(await raw(key)); requireValue(Number.isInteger(count) && count > 0 && count <= 128, "SIGNING_PROFILE_INVALID"); const values: string[] = []; for (let i = 0; i < count; i++) values.push(await raw(key + "." + i)); return values; };
  const entitlements = JSON.parse(await plistValue(decoded, "Entitlements", "json", input)) as Record<string, unknown>;
  return { uuid: await raw("UUID"), teamIdentifiers: await array("TeamIdentifier"), prefixes: await array("ApplicationIdentifierPrefix"),
    applicationIdentifier: String(entitlements["application-identifier"]), expiresAt: await raw("ExpirationDate"),
    developerCertificates: await array("DeveloperCertificates"), platform: await raw("Platform.0"), entitlements };
}
async function trustedAppleRoots(directory: PrivateSigningDirectory, input: IOSSigningInput): Promise<string> {
  const output = await command(input.tools?.security ?? "/usr/bin/security", ["find-certificate", "-a", "-p", "/System/Library/Keychains/SystemRootCertificates.keychain"], input, { maxBytes: 4 * 1024 * 1024 });
  const certificates = output.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const roots = certificates.filter(pem => { const cert = new X509Certificate(pem); return cert.subject.split("\n").some(line => /^CN=Apple Root CA(?: - G[23])?$/.test(line)) && cert.verify(cert.publicKey); });
  requireValue(roots.length > 0, "SIGNING_PROFILE_INVALID"); return directory.write("apple-roots.pem", roots.join("\n"));
}
export async function withIOSSigningMaterial<T>(input: IOSSigningInput, use: (material: IOSSigningMaterial) => Promise<T>): Promise<T> {
  validateContext(input); requireValue(process.platform === "darwin", "SIGNING_TOOL_FAILED"); secret(input.certificate.password);
  const certificateBytes = bytes(input.certificate.fileBase64), provisioningBytes = bytes(input.provisioning.fileBase64);
  return withPrivateSigningDirectory(input, async directory => {
    const security = input.tools?.security ?? "/usr/bin/security", openssl = input.tools?.openssl ?? "/usr/bin/openssl", keychainPath = join(directory.path, "signing.keychain-db");
    let keychainCreated = false;
    try {
      const certificatePath = await directory.write("certificate.p12", certificateBytes), provisioningPath = await directory.write("profile.mobileprovision", provisioningBytes);
      const decoded = await directory.write("profile.plist", Buffer.alloc(0)), verified = await directory.write("profile-verified.plist", Buffer.alloc(0)), profileSigner = await directory.write("profile-signer.pem", Buffer.alloc(0));
      const roots = await trustedAppleRoots(directory, input);
      // Decode plus independently verify the signed CMS payload against Apple roots.
      await command(openssl, ["cms", "-verify", "-binary", "-inform", "DER", "-in", provisioningPath, "-CAfile", roots, "-purpose", "any", "-signer", profileSigner, "-out", verified], input);
      // Apple developer certificates also chain to these roots. Only Apple's
      // dedicated provisioning signer may authorize a profile (Security policy
      // SecPolicyCreateiPhoneProvisioningProfileSigning pins this common name).
      const profileSignerCertificates = (await readFile(profileSigner, "utf8")).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
      requireValue(profileSignerCertificates.length === 1 && new X509Certificate(profileSignerCertificates[0]!).subject.split("\n").includes("CN=Apple iPhone OS Provisioning Profile Signing"), "SIGNING_PROFILE_INVALID");
      await command(security, ["cms", "-D", "-i", provisioningPath, "-o", decoded], input);
      requireValue(sha256(await readFile(decoded)) === sha256(await readFile(verified)), "SIGNING_PROFILE_INVALID");
      const profile = await profileFields(decoded, input);
      const certificatePem = await command(openssl, ["pkcs12", "-in", certificatePath, "-clcerts", "-nokeys", "-passin", "stdin"], input, { stdin: input.certificate.password + "\n" });
      const privateKeyPem = await command(openssl, ["pkcs12", "-in", certificatePath, "-nocerts", "-nodes", "-passin", "stdin"], input, { stdin: input.certificate.password + "\n" });
      const summary = validateIOSIdentity({ certificatePem, privateKeyPem, profile, teamId: input.teamId, applicationId: input.applicationId, expectedCertificateSha256: input.expectedCertificateSha256 });
      const importPath = await directory.write("keychain-import.pem", certificatePem + "\n" + privateKeyPem);
      // Empty disposable password is intentional: this 0700 directory is the
      // access boundary. No production password is exposed through security argv.
      await command(security, ["create-keychain", "-p", "", keychainPath], input); keychainCreated = true;
      await chmod(keychainPath, 0o600);
      await command(security, ["unlock-keychain", "-p", "", keychainPath], input);
      await command(security, ["import", importPath, "-k", keychainPath, "-f", "pemseq", "-x", "-T", "/usr/bin/codesign"], input);
      await command(security, ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", "", keychainPath], input);
      await rm(importPath); await rm(certificatePath);
      cancelled(input.signal); return await use({ directory: directory.path, keychainPath, provisioningPath, profile, summary });
    } catch (error) { throw safeFailure(error, input.signal); }
    finally {
      certificateBytes.fill(0); provisioningBytes.fill(0);
      if (keychainCreated || await lstat(keychainPath).then(() => true, () => false)) {
        try { const { signal: _signal, ...cleanupInput } = input; await command(security, ["delete-keychain", keychainPath], cleanupInput); }
        catch { fail("SIGNING_CLEANUP_UNCONFIRMED"); }
      }
    }
  });
}

async function regularFile(path: string): Promise<string> { requireValue(isAbsolute(path), "SIGNING_PATH_INVALID"); const info = await lstat(path); requireValue(info.isFile() && !info.isSymbolicLink(), "SIGNING_ARTIFACT_INVALID"); return realpath(path); }
async function publishFile(source: string, output: string) { requireValue(isAbsolute(output), "SIGNING_PATH_INVALID"); requireValue((await lstat(dirname(output))).isDirectory() && !(await lstat(dirname(output))).isSymbolicLink(), "SIGNING_PATH_INVALID"); const canonical = join(await realpath(dirname(output)), basename(output)); await copyFile(source, canonical, constants.COPYFILE_EXCL); await chmod(canonical, 0o600); }
export async function signAndroidApk(input: AndroidSigningInput & { unsignedApk: string; outputApk: string }): Promise<NativeSigningReceipt> {
  validateContext(input); const sdkTools = join(homedir(), "Library/Android/sdk/build-tools/36.0.0"), aapt2 = input.tools?.aapt2 ?? join(sdkTools, "aapt2");
  // Freeze and inspect an unsigned build before a single signing key is written.
  return withPrivateSigningDirectory(input, async staging => {
    const frozen = await staging.write("unsigned.apk", Buffer.alloc(0)); await copyFile(await regularFile(input.unsignedApk), frozen); await chmod(frozen, 0o600);
    const badging = await command(aapt2, ["dump", "badging", frozen], input); requireValue(/^package: name='([^']+)'/m.exec(badging)?.[1] === input.applicationId, "SIGNING_ARTIFACT_INVALID");
    const aligned = join(staging.path, "aligned.apk"); await command(input.tools?.zipalign ?? join(sdkTools, "zipalign"), ["-p", "4", frozen, aligned], input); await chmod(aligned, 0o600);
    return withAndroidSigningMaterial(input, async material => {
      const signed = join(material.directory, "signed.apk"), apksigner = input.tools?.apksigner ?? join(sdkTools, "apksigner");
      await command(apksigner, ["sign", "--ks", material.keystorePath, "--ks-key-alias", input.credential.keyAlias, "--ks-pass", "env:FLORA_SIGN_STORE_PASSWORD", "--key-pass", "env:FLORA_SIGN_KEY_PASSWORD", "--out", signed, aligned], input,
        { env: { FLORA_SIGN_STORE_PASSWORD: input.credential.password, FLORA_SIGN_KEY_PASSWORD: input.credential.keyPassword ?? input.credential.password } });
      await chmod(signed, 0o600);
      const verification = await command(apksigner, ["verify", "--verbose", "--print-certs", signed], input);
      const signers = [...verification.matchAll(/^Signer #(\d+) certificate SHA-256 digest: ([a-fA-F0-9:]+)$/gm)];
      requireValue(signers.length === 1 && signers[0]?.[1] === "1" && fingerprint(signers[0]![2]!) === material.summary.certificateSha256, "SIGNING_IDENTITY_INVALID");
      const signedBadging = await command(aapt2, ["dump", "badging", signed], input); requireValue(/^package: name='([^']+)'/m.exec(signedBadging)?.[1] === input.applicationId, "SIGNING_ARTIFACT_INVALID");
      const artifactSha256 = sha256(await readFile(signed)); await publishFile(signed, input.outputApk);
      return { ...material.summary, platform: "android", artifactPath: input.outputApk, artifactSha256 };
    });
  });
}

async function copyAppTree(source: string, output: string): Promise<string[]> {
  requireValue(isAbsolute(source) && (await lstat(source)).isDirectory() && !(await lstat(source)).isSymbolicLink(), "SIGNING_ARTIFACT_INVALID");
  await mkdir(output, { mode: 0o700 }); const files: string[] = []; let size = 0;
  const walk = async (from: string, to: string) => {
    for (const item of (await readdir(from)).sort()) {
      const original = join(from, item), destination = join(to, item), info = await lstat(original);
      requireValue(!info.isSymbolicLink() && !item.endsWith(".appex") && !item.endsWith(".app"), "SIGNING_ARTIFACT_INVALID");
      if (info.isDirectory()) { await mkdir(destination, { mode: 0o700 }); await walk(original, destination); }
      else {
        requireValue(info.isFile(), "SIGNING_ARTIFACT_INVALID"); size += info.size; requireValue(size <= 1_000_000_000 && files.length < 20000, "SIGNING_ARTIFACT_INVALID");
        const inputFile = await open(original, constants.O_RDONLY | constants.O_NOFOLLOW), outputFile = await open(destination, "wx", info.mode & 0o111 ? 0o700 : 0o600);
        try {
          const openedInfo = await inputFile.stat(); requireValue(openedInfo.isFile() && openedInfo.dev === info.dev && openedInfo.ino === info.ino && openedInfo.size === info.size, "SIGNING_ARTIFACT_INVALID");
          const buffer = Buffer.alloc(1024 * 1024); let position = 0;
          for (;;) { const read = await inputFile.read(buffer, 0, buffer.length, position); if (!read.bytesRead) break; requireValue(position + read.bytesRead <= info.size, "SIGNING_ARTIFACT_INVALID"); let written = 0; while (written < read.bytesRead) { const result = await outputFile.write(buffer, written, read.bytesRead - written, position + written); requireValue(result.bytesWritten > 0, "SIGNING_ARTIFACT_INVALID"); written += result.bytesWritten; } position += read.bytesRead; }
          const closedInfo = await inputFile.stat(); requireValue(position === info.size && closedInfo.dev === info.dev && closedInfo.ino === info.ino && closedInfo.size === info.size && closedInfo.mtimeMs === openedInfo.mtimeMs && closedInfo.ctimeMs === openedInfo.ctimeMs, "SIGNING_ARTIFACT_INVALID");
        }
        finally { await inputFile.close(); await outputFile.close(); }
        files.push(destination);
      }
    }
  }; await walk(source, output); return files;
}
async function appTreeHash(path: string): Promise<string> {
  const hash = createHash("sha256"); const walk = async (directory: string) => { for (const name of (await readdir(directory)).sort()) { const file = join(directory, name), info = await lstat(file); requireValue(!info.isSymbolicLink(), "SIGNING_ARTIFACT_INVALID"); if (info.isDirectory()) await walk(file); else { requireValue(info.isFile(), "SIGNING_ARTIFACT_INVALID"); hash.update(JSON.stringify([relative(path, file), info.size]) + "\n"); const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { for await (const chunk of fd.createReadStream({ autoClose: false })) hash.update(chunk); } finally { await fd.close(); } } } }; await walk(path); return hash.digest("hex");
}
function thinMachO(headerAndCommands: Buffer, kind: "executable" | "library") {
  requireValue(headerAndCommands.length >= 32 && headerAndCommands.readUInt32LE(0) === 0xfeedfacf && headerAndCommands.readUInt32LE(4) === 0x0100000c, "SIGNING_ARTIFACT_INVALID");
  requireValue(headerAndCommands.readUInt32LE(12) === (kind === "executable" ? 2 : 6), "SIGNING_ARTIFACT_INVALID");
  const count = headerAndCommands.readUInt32LE(16), size = headerAndCommands.readUInt32LE(20);
  requireValue(count > 0 && count <= 8192 && size <= 1024 * 1024 && headerAndCommands.length >= 32 + size, "SIGNING_ARTIFACT_INVALID");
  let offset = 32, platformFound = false;
  for (let i = 0; i < count; i++) {
    requireValue(offset + 8 <= 32 + size, "SIGNING_ARTIFACT_INVALID"); const command = headerAndCommands.readUInt32LE(offset), commandSize = headerAndCommands.readUInt32LE(offset + 4);
    requireValue(commandSize >= 8 && commandSize % 4 === 0 && offset + commandSize <= 32 + size, "SIGNING_ARTIFACT_INVALID");
    if (command === 0x32) { requireValue(commandSize >= 24 && headerAndCommands.readUInt32LE(offset + 8) === 2, "SIGNING_ARTIFACT_INVALID"); platformFound = true; }
    else if (command === 0x25) { requireValue(commandSize >= 16, "SIGNING_ARTIFACT_INVALID"); platformFound = true; }
    else requireValue(![0x24, 0x2f, 0x30].includes(command), "SIGNING_ARTIFACT_INVALID");
    offset += commandSize;
  }
  requireValue(platformFound && offset === 32 + size, "SIGNING_ARTIFACT_INVALID");
}
/** Buffer helper for fixtures and callers who already bounded their input. */
export function validateIOSMachO(input: Uint8Array, kind: "executable" | "library" = "executable"): void {
  try { thinMachO(Buffer.from(input), kind); } catch { fail("SIGNING_ARTIFACT_INVALID"); }
}
async function inspectIOSMachO(path: string, kind: "executable" | "library") {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fileSize = (await fd.stat()).size;
    const read = async (offset: number, size: number) => { requireValue(Number.isSafeInteger(offset) && offset >= 0 && size <= 1024 * 1024 + 32 && offset + size <= fileSize, "SIGNING_ARTIFACT_INVALID"); const data = Buffer.alloc(size); const result = await fd.read(data, 0, size, offset); requireValue(result.bytesRead === size, "SIGNING_ARTIFACT_INVALID"); return data; };
    const first = await read(0, 32), magic = first.readUInt32BE(0), slices: Array<{ offset: number; size: number; subtype?: number }> = [];
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
      const count = first.readUInt32BE(4), entrySize = magic === 0xcafebabf ? 32 : 20; requireValue(count > 0 && count <= 8, "SIGNING_ARTIFACT_INVALID");
      const table = await read(8, count * entrySize);
      for (let i = 0; i < count; i++) {
        const cursor = i * entrySize; requireValue(table.readUInt32BE(cursor) === 0x0100000c, "SIGNING_ARTIFACT_INVALID");
        const offset = entrySize === 32 ? Number(table.readBigUInt64BE(cursor + 8)) : table.readUInt32BE(cursor + 8), size = entrySize === 32 ? Number(table.readBigUInt64BE(cursor + 16)) : table.readUInt32BE(cursor + 12);
        const alignment = table.readUInt32BE(cursor + (entrySize === 32 ? 24 : 16));
        requireValue(Number.isSafeInteger(offset) && Number.isSafeInteger(size) && offset >= 8 + count * entrySize && size >= 32 && offset + size <= fileSize && alignment <= 31 && offset % 2 ** alignment === 0 &&
          !slices.some(slice => offset < slice.offset + slice.size && slice.offset < offset + size), "SIGNING_ARTIFACT_INVALID");
        slices.push({ offset, size, subtype: table.readUInt32BE(cursor + 4) });
      }
    } else slices.push({ offset: 0, size: fileSize });
    for (const slice of slices) { const header = await read(slice.offset, 32), size = header.readUInt32LE(20); requireValue(size <= 1024 * 1024 && size + 32 <= slice.size && (slice.subtype === undefined || header.readUInt32LE(8) === slice.subtype), "SIGNING_ARTIFACT_INVALID"); thinMachO(await read(slice.offset, 32 + size), kind); }
  } catch { fail("SIGNING_ARTIFACT_INVALID"); } finally { await fd.close(); }
}
/** Extract only the public certificate. The prefix must be the same argv token
 * as this optional codesign option; a separate token becomes another artifact.
 */
export async function extractIOSSigningCertificate(path: string, directory: string, input: SigningJobContext): Promise<Buffer> {
  requireValue(isAbsolute(path) && !/[\r\n\0]/.test(path) && isAbsolute(directory), "SIGNING_PATH_INVALID");
  const parent = await lstat(directory); requireValue(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o077) === 0 && parent.uid === process.getuid?.(), "SIGNING_PATH_INVALID");
  const prefix = join(directory, "verified-cert-" + randomBytes(16).toString("hex") + "-");
  await command(input.tools?.codesign ?? "/usr/bin/codesign", ["--display", "--extract-certificates=" + prefix, path], input);
  const leaf = await open(prefix + "0", constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await leaf.stat(); requireValue(info.isFile() && info.nlink === 1 && info.uid === process.getuid?.() && info.size > 0 && info.size <= 65536, "SIGNING_IDENTITY_INVALID");
    await chmod(prefix + "0", 0o600); const certificate = await leaf.readFile(); requireValue(certificate.length === info.size, "SIGNING_IDENTITY_INVALID");
    try { new X509Certificate(certificate); } catch { fail("SIGNING_IDENTITY_INVALID"); } return certificate;
  } finally { await leaf.close(); }
}
/** plutil accepts JSON, but codesign/CoreFoundation does not recognize that as
 * an application Info.plist and can omit entitlements while verifying a generic
 * bundle successfully. Check the bounded original format before any key access;
 * subsequent plutil field reads still validate the plist contents and identity.
 */
async function validateBundleInfoPlist(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail("SIGNING_ARTIFACT_INVALID"));
  try {
    const info = await fd.stat(); requireValue(info.isFile() && info.size > 0 && info.size <= 1024 * 1024, "SIGNING_ARTIFACT_INVALID");
    const header = Buffer.alloc(Math.min(info.size, 4096)), read = await fd.read(header, 0, header.length, 0);
    requireValue(read.bytesRead === header.length, "SIGNING_ARTIFACT_INVALID");
    if (header.subarray(0, 8).equals(Buffer.from("bplist00"))) return;
    let xml: string;
    if (header[0] === 0xff && header[1] === 0xfe) xml = header.subarray(2).toString("utf16le");
    else if (header[0] === 0xfe && header[1] === 0xff) xml = Buffer.from(header.subarray(2, header.length - header.length % 2)).swap16().toString("utf16le");
    else xml = header.toString("utf8");
    requireValue(/^[\uFEFF\s]*</.test(xml), "SIGNING_ARTIFACT_INVALID");
  } catch { fail("SIGNING_ARTIFACT_INVALID"); } finally { await fd.close(); }
}
/** A valid signature alone does not prove that the requested capabilities were
 * embedded. Read the app's XML entitlements explicitly and compare all keys and
 * values with the narrowed, profile-authorized selection, including extras.
 */
export async function verifyIOSSignedEntitlements(path: string, expected: Record<string, unknown>, input: SigningJobContext): Promise<void> {
  requireValue(isAbsolute(path) && !/[\r\n\0]/.test(path), "SIGNING_PATH_INVALID");
  const xml = await command(input.tools?.codesign ?? "/usr/bin/codesign", ["-d", "--entitlements", ":-", path], input);
  requireValue(xml.trimStart().startsWith("<?xml"), "SIGNING_ENTITLEMENTS_INVALID");
  const json = await command(input.tools?.plutil ?? "/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], input, { stdin: xml });
  let actual: unknown;
  try { actual = JSON.parse(json); } catch { fail("SIGNING_ENTITLEMENTS_INVALID"); }
  requireValue(actual && typeof actual === "object" && !Array.isArray(actual) && Object.keys(actual).length <= 128 && isDeepStrictEqual(actual, expected), "SIGNING_ENTITLEMENTS_INVALID");
}
export async function signIOSApp(input: IOSSigningInput & { unsignedApp: string; outputApp: string; requestedEntitlements?: Record<string, unknown> }): Promise<NativeSigningReceipt> {
  validateContext(input); requireValue(isAbsolute(input.outputApp) && input.outputApp.endsWith(".app"), "SIGNING_PATH_INVALID");
  return withPrivateSigningDirectory(input, async staging => {
    const app = join(staging.path, "Application.app"); const files = await copyAppTree(input.unsignedApp, app);
    await validateBundleInfoPlist(join(app, "Info.plist"));
    requireValue((await plistValue(join(app, "Info.plist"), "CFBundleIdentifier", "raw", input)).trim() === input.applicationId, "SIGNING_ARTIFACT_INVALID");
    requireValue((await plistValue(join(app, "Info.plist"), "CFBundleSupportedPlatforms.0", "raw", input)).trim() === "iPhoneOS", "SIGNING_ARTIFACT_INVALID");
    const executableName = (await plistValue(join(app, "Info.plist"), "CFBundleExecutable", "raw", input)).trim(); requireValue(/^[A-Za-z0-9_.-]{1,128}$/.test(executableName) && files.includes(join(app, executableName)), "SIGNING_ARTIFACT_INVALID");
    await inspectIOSMachO(join(app, executableName), "executable");
    const frameworkPaths = new Set<string>();
    for (const file of files) { if (file.endsWith(".dylib")) await inspectIOSMachO(file, "library"); const framework = /^(.*\.framework)(?:\/|$)/.exec(file); if (framework) frameworkPaths.add(framework[1]!); }
    for (const framework of frameworkPaths) { await validateBundleInfoPlist(join(framework, "Info.plist")); const name = (await plistValue(join(framework, "Info.plist"), "CFBundleExecutable", "raw", input)).trim(); requireValue(/^[A-Za-z0-9_.-]{1,128}$/.test(name) && files.includes(join(framework, name)), "SIGNING_ARTIFACT_INVALID"); await inspectIOSMachO(join(framework, name), "library"); }
    return withIOSSigningMaterial(input, async material => {
      const entitlements = selectIOSEntitlements(material.profile, input.applicationId, input.teamId, input.requestedEntitlements);
      const jsonPath = join(material.directory, "entitlements.json"); await writeFile(jsonPath, JSON.stringify(entitlements), { mode: 0o600, flag: "wx" });
      const entitlementsPath = join(material.directory, "entitlements.plist"); await command(input.tools?.plutil ?? "/usr/bin/plutil", ["-convert", "xml1", "-o", entitlementsPath, jsonPath], input); await chmod(entitlementsPath, 0o600);
      await copyFile(material.provisioningPath, join(app, "embedded.mobileprovision")); await chmod(join(app, "embedded.mobileprovision"), 0o600);
      const codesign = input.tools?.codesign ?? "/usr/bin/codesign", targets = new Set<string>();
      for (const file of files) { const framework = /^(.*\.framework)(?:\/|$)/.exec(file); if (framework) targets.add(framework[1]!); else if (file.endsWith(".dylib")) targets.add(file); }
      for (const target of [...targets].sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b))) {
        await command(codesign, ["--force", "--sign", material.summary.certificateSha1, "--keychain", material.keychainPath, "--timestamp=none", target], input);
      }
      await command(codesign, ["--force", "--sign", material.summary.certificateSha1, "--keychain", material.keychainPath, "--entitlements", entitlementsPath, "--generate-entitlement-der", "--timestamp=none", app], input);
      await command(codesign, ["--verify", "--deep", "--strict", app], input);
      await verifyIOSSignedEntitlements(app, entitlements, input);
      const extracted = await extractIOSSigningCertificate(app, material.directory, input);
      requireValue(sha256(extracted) === material.summary.certificateSha256, "SIGNING_IDENTITY_INVALID");
      const artifactSha256 = await appTreeHash(app); requireValue((await lstat(dirname(input.outputApp))).isDirectory() && !(await lstat(dirname(input.outputApp))).isSymbolicLink(), "SIGNING_PATH_INVALID");
      await copyAppTree(app, input.outputApp);
      return { ...material.summary, platform: "ios", artifactPath: input.outputApp, artifactSha256, profileUuid: material.summary.profileUuid };
    });
  });
}
