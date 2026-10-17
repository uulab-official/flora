import test from "node:test";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat, readdir, symlink, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { trustedProcess, processEnvironment } from "../dist/process.js";
import type { NativeSigningDiagnostic } from "../dist/native-signing.js";

type SigningAPI = typeof import("../dist/native-signing.js");
const api = await import("../dist/native-signing.js").catch(() => ({})) as SigningAPI;
const teamId = "TESTTEAM01", applicationId = "kr.co.uulab.signingfixture";
const storePassword = "fixture-secret-not-for-logs", alias = "release-fixture";
const fixtures = await mkdtemp(join(tmpdir(), "flora-native-fixture-"));

async function certificate(name: string) {
  const key = join(fixtures, name + ".key"), cert = join(fixtures, name + ".pem");
  await trustedProcess("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "30", "-subj", `/CN=Apple Distribution Fixture/OU=${teamId}/O=Flora Test`]);
  const pem = await readFile(cert, "utf8"), privateKeyPem = await readFile(key, "utf8"), parsed = new X509Certificate(pem);
  return { pem, privateKeyPem, parsed, sha256: createHash("sha256").update(parsed.raw).digest("hex"), key, cert };
}
const fixture = await certificate("identity"), other = await certificate("other");
function profile(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "00000000-0000-4000-8000-000000000001", teamIdentifiers: [teamId], prefixes: [teamId],
    applicationIdentifier: teamId + "." + applicationId, expiresAt: new Date(Date.now() + 86400000).toISOString(),
    developerCertificates: [fixture.parsed.raw.toString("base64")], platform: "iOS",
    entitlements: { "application-identifier": teamId + "." + applicationId,
      "com.apple.developer.team-identifier": teamId, "get-task-allow": false, "keychain-access-groups": [teamId + ".*"] },
    ...overrides,
  };
}
function iosIdentity(overrides: Record<string, unknown> = {}) {
  return { certificatePem: fixture.pem, privateKeyPem: fixture.privateKeyPem, profile: profile(), teamId,
    applicationId, expectedCertificateSha256: fixture.sha256, ...overrides };
}

const keytool = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "keytool") : "/usr/bin/keytool";
const hasKeytool = await stat(keytool).then(() => true, () => false);
const keystore = join(fixtures, "release.jks");
if (hasKeytool) await trustedProcess(keytool, ["-genkeypair", "-alias", alias, "-keystore", keystore, "-storetype", "JKS", "-storepass:env", "FLORA_TEST_STORE_PASSWORD",
  "-keypass:env", "FLORA_TEST_KEY_PASSWORD", "-keyalg", "RSA", "-keysize", "2048", "-dname", "CN=Flora Fixture", "-validity", "30", "-noprompt"],
  { env: processEnvironment({ FLORA_TEST_STORE_PASSWORD: storePassword, FLORA_TEST_KEY_PASSWORD: storePassword }) });
const certificateOutput = hasKeytool ? await trustedProcess(keytool, ["-exportcert", "-rfc", "-alias", alias, "-keystore", keystore, "-storepass:env", "FLORA_TEST_STORE_PASSWORD"],
  { env: processEnvironment({ FLORA_TEST_STORE_PASSWORD: storePassword }) }) : fixture.pem;
const androidSha = createHash("sha256").update(new X509Certificate(certificateOutput).raw).digest("hex");
const credential = { fileBase64: hasKeytool ? (await readFile(keystore)).toString("base64") : "fixture", password: storePassword, keyAlias: alias, keyPassword: storePassword };
const androidInput = { jobId: "android-fixture", appId: "app-fixture", applicationId, expectedCertificateSha256: androidSha, credential, tools: { keytool, openssl: "/usr/bin/openssl" } };
const androidSdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk"), buildTools = join(androidSdk, "build-tools/36.0.0"), androidJar = join(androidSdk, "platforms/android-36/android.jar");
const hasAndroidTools = hasKeytool && (await Promise.all(["aapt2", "apksigner", "zipalign"].map(name => stat(join(buildTools, name)).then(() => true, () => false)))).every(Boolean) && await stat(androidJar).then(() => true, () => false);
const manifest = join(fixtures, "AndroidManifest.xml"), unsignedApk = join(fixtures, "unsigned.apk");
await writeFile(manifest, `<?xml version="1.0" encoding="utf-8"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${applicationId}" android:versionCode="1" android:versionName="1.0"><uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36"/><application android:label="Flora signing fixture" android:hasCode="false"/></manifest>`);
if (hasAndroidTools) await trustedProcess(join(buildTools, "aapt2"), ["link", "-I", androidJar, "--manifest", manifest, "-o", unsignedApk]);
const allAndroidTools = { ...androidInput.tools, aapt2: join(buildTools, "aapt2"), apksigner: join(buildTools, "apksigner"), zipalign: join(buildTools, "zipalign") };
const certificateP12 = join(fixtures, "identity.p12");
await trustedProcess("/usr/bin/openssl", ["pkcs12", "-export", "-in", fixture.cert, "-inkey", fixture.key, "-out", certificateP12, "-passout", "stdin"], { input: storePassword + "\n" });
const signedProfile = join(fixtures, "untrusted.mobileprovision");
await trustedProcess("/usr/bin/openssl", ["cms", "-sign", "-in", manifest, "-signer", fixture.cert, "-inkey", fixture.key, "-out", signedProfile, "-outform", "DER", "-nodetach", "-binary", "-md", "sha256"]);
test.after(() => rm(fixtures, { recursive: true, force: true }));

test("generated certificate/private key and exact provisioning app are validated", () => {
  assert.equal(typeof api.validateIOSIdentity, "function");
  const result = api.validateIOSIdentity(iosIdentity());
  assert.equal(result.certificateSha256, fixture.sha256);
  assert.equal(result.applicationId, applicationId);
  assert.equal(result.profileUuid, profile().uuid);
  assert.equal(result.teamId, teamId);
});
test("iOS refuses another app, team, certificate, expired profile and private key mismatch", () => {
  assert.equal(typeof api.validateIOSIdentity, "function");
  for (const input of [iosIdentity({ applicationId: "kr.co.uulab.other" }), iosIdentity({ teamId: "OTHERTEAM1" }),
    iosIdentity({ expectedCertificateSha256: other.sha256 }), iosIdentity({ privateKeyPem: other.privateKeyPem }),
    iosIdentity({ profile: profile({ expiresAt: "2020-01-01T00:00:00Z" }) }),
    iosIdentity({ profile: profile({ developerCertificates: [other.parsed.raw.toString("base64")] }) }),
    iosIdentity({ profile: profile({ applicationIdentifier: teamId + ".*" }) }),
    iosIdentity({ profile: profile({ entitlements: { "application-identifier": teamId + "." + applicationId,
      "com.apple.developer.team-identifier": teamId, "get-task-allow": true } }) })]) {
    assert.throws(() => api.validateIOSIdentity(input), (error: unknown) => {
      assert.match((error as Error).message, /^SIGNING_[A-Z_]+$/);
      assert.ok(!(error as Error).message.includes(storePassword)); return true;
    });
  }
});
test("iOS entitlement selection narrows wildcard keychain scope and rejects extra privileges", () => {
  assert.equal(typeof api.selectIOSEntitlements, "function");
  const selected = api.selectIOSEntitlements(profile(), applicationId, teamId);
  assert.deepEqual(selected["keychain-access-groups"], [teamId + "." + applicationId]);
  assert.equal(selected["get-task-allow"], false);
  for (const requested of [ { "get-task-allow": true }, { "keychain-access-groups": [teamId + ".other"] },
    { "com.apple.security.application-groups": ["group.foreign"] }, { "application-identifier": teamId + ".other" } ]) {
    assert.throws(() => api.selectIOSEntitlements(profile(), applicationId, teamId, requested), /^Error: SIGNING_ENTITLEMENTS_INVALID$/);
  }
});
function distributionProfile(app = applicationId, extra: Record<string, unknown> = {}) {
  return profile({ applicationIdentifier: teamId + "." + app, entitlements: {
    "application-identifier": teamId + "." + app, "com.apple.developer.team-identifier": teamId, "get-task-allow": false,
    "keychain-access-groups": [teamId + ".*"], "aps-environment": "production", "beta-reports-active": true,
    "com.apple.developer.associated-domains": "*", "com.apple.developer.applesignin": ["Default"], ...extra,
  } });
}
test("requested Universal Links survive wildcard profiles and App Store push is production without inventing profile capabilities", () => {
  const requested = { "aps-environment": "development", "com.apple.developer.associated-domains": ["applinks:isso.uulab.co.kr"] };
  const original = structuredClone(requested), selected = api.selectIOSEntitlements(distributionProfile("kr.co.uulab.isso"), "kr.co.uulab.isso", teamId, requested);
  assert.deepEqual(selected["com.apple.developer.associated-domains"], requested["com.apple.developer.associated-domains"]);
  assert.equal(selected["aps-environment"], "production"); assert.equal(Object.hasOwn(selected, "com.apple.developer.applesignin"), false);
  assert.deepEqual(requested, original);
  const promise = api.selectIOSEntitlements(distributionProfile("kr.co.uulab.promise"), "kr.co.uulab.promise", teamId,
    { "com.apple.developer.associated-domains": ["applinks:promise.uulab.co.kr"] });
  assert.deepEqual(promise["com.apple.developer.associated-domains"], ["applinks:promise.uulab.co.kr"]);
  assert.equal(Object.hasOwn(promise, "com.apple.developer.applesignin"), false);
});
test("associated-domain arrays are bounded and typed; unsupported entitlement and cross-app keychain escalation refuse", () => {
  for (const domains of ["applinks:isso.uulab.co.kr", [42], [null], [{}], [["applinks:isso.uulab.co.kr"]], [""], ["*"], ["applinks:https://isso.uulab.co.kr"],
    ["applinks:isso.uulab.co.kr/private"], ["applinks:isso.uulab.co.kr\nforeign"], ["applinks:isso..uulab.co.kr"],
    ["applinks:" + "x".repeat(1025)], Array(129).fill("applinks:isso.uulab.co.kr"), Array(1)]) {
    assert.throws(() => api.selectIOSEntitlements(distributionProfile(), applicationId, teamId,
      { "com.apple.developer.associated-domains": domains }), /^Error: SIGNING_ENTITLEMENTS_INVALID$/);
  }
  assert.throws(() => api.selectIOSEntitlements(profile(), applicationId, teamId,
    { "com.apple.developer.associated-domains": ["applinks:isso.uulab.co.kr"] }), /^Error: SIGNING_ENTITLEMENTS_INVALID$/);
  assert.throws(() => api.selectIOSEntitlements(distributionProfile(applicationId, { "com.apple.security.application-groups": "*" }), applicationId, teamId,
    { "com.apple.security.application-groups": ["group.foreign"] }), /^Error: SIGNING_ENTITLEMENTS_INVALID$/);
  assert.throws(() => api.selectIOSEntitlements(distributionProfile(), applicationId, teamId,
    { "keychain-access-groups": [teamId + ".foreign"] }), /^Error: SIGNING_ENTITLEMENTS_INVALID$/);
  const constrained = distributionProfile(applicationId, { "com.apple.developer.associated-domains": ["applinks:isso.uulab.co.kr"] });
  assert.deepEqual(api.selectIOSEntitlements(constrained, applicationId, teamId,
    { "com.apple.developer.associated-domains": ["applinks:isso.uulab.co.kr"] })["com.apple.developer.associated-domains"], ["applinks:isso.uulab.co.kr"]);
  assert.throws(() => api.selectIOSEntitlements(constrained, applicationId, teamId,
    { "com.apple.developer.associated-domains": ["applinks:foreign.uulab.co.kr"] }), /^Error: SIGNING_ENTITLEMENTS_INVALID$/);
});
test("APNs environment conversion is limited to verified App Store production profiles and known source environments", () => {
  for (const [extra, aps] of [[{}, "foreign"], [{ "beta-reports-active": false }, "development"], [{ "get-task-allow": true }, "development"],
    [{ "aps-environment": "development" }, "production"], [{ "aps-environment": undefined }, "development"]] as const) {
    assert.throws(() => api.selectIOSEntitlements(distributionProfile(applicationId, extra), applicationId, teamId,
      { "aps-environment": aps }), /^Error: SIGNING_ENTITLEMENTS_INVALID$/);
  }
  assert.equal(api.selectIOSEntitlements(distributionProfile(), applicationId, teamId, { "aps-environment": "production" })["aps-environment"], "production");
});

test("private job directory and files have restrictive modes and are always removed", async () => {
  assert.equal(typeof api.withPrivateSigningDirectory, "function");
  const parent = await mkdtemp(join(fixtures, "owned-")); let owned = "";
  const result = await api.withPrivateSigningDirectory({ jobId: "job-fixture-1", appId: "app-fixture", temporaryRoot: parent }, async directory => {
    owned = directory.path; assert.equal((await stat(directory.path)).mode & 0o777, 0o700);
    const file = await directory.write("credential.bin", Buffer.from("private-material"));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.throws(() => directory.write("../escape", Buffer.from("private-material")), /^Error: SIGNING_PATH_INVALID$/);
    return "completed";
  });
  assert.equal(result, "completed"); await assert.rejects(stat(owned), { code: "ENOENT" }); assert.deepEqual(await readdir(parent), []);
  await assert.rejects(api.withPrivateSigningDirectory({ jobId: "job-fixture-2", appId: "app-fixture", temporaryRoot: parent }, async directory => {
    owned = directory.path; await directory.write("secret", Buffer.from("private-material")); throw new Error("caller failure");
  }), /^Error: caller failure$/);
  await assert.rejects(stat(owned), { code: "ENOENT" }); assert.deepEqual(await readdir(parent), []);
});


test("real keytool validates keystore alias, private key and pinned certificate then cleans up", { skip: !hasKeytool }, async () => {
  assert.equal(typeof api.withAndroidSigningMaterial, "function"); let materialPath = "";
  const result = await api.withAndroidSigningMaterial(androidInput, async material => {
    materialPath = material.keystorePath;
    assert.equal((await stat(materialPath)).mode & 0o777, 0o600);
    assert.equal(material.summary.certificateSha256, androidSha);
    assert.equal(material.summary.applicationId, applicationId);
    return material.summary;
  });
  assert.equal(result.certificateSha256, androidSha); await assert.rejects(stat(materialPath), { code: "ENOENT" });
});
test("keystore wrong alias, password, key password or signer refuses before consumption and redacts errors", { skip: !hasKeytool }, async () => {
  assert.equal(typeof api.withAndroidSigningMaterial, "function");
  for (const input of [ { ...androidInput, credential: { ...credential, keyAlias: "foreign" } },
    { ...androidInput, credential: { ...credential, password: "wrong-sensitive-password" } },
    { ...androidInput, credential: { ...credential, keyPassword: "wrong-sensitive-password" } },
    { ...androidInput, expectedCertificateSha256: "0".repeat(64) } ]) {
    let consumed = false;
    await assert.rejects(api.withAndroidSigningMaterial(input, async () => { consumed = true; }), (error: unknown) => {
      const serialized = String(error) + JSON.stringify(error); assert.match((error as Error).message, /^SIGNING_[A-Z_]+$/);
      assert.ok(!serialized.includes(storePassword)); assert.ok(!serialized.includes("wrong-sensitive-password")); return true;
    }); assert.equal(consumed, false);
  }
});
test("keystore malformed input and cancellation never reach consumers", async () => {
  assert.equal(typeof api.withAndroidSigningMaterial, "function"); const controller = new AbortController(); controller.abort();
  await assert.rejects(api.withAndroidSigningMaterial({ ...androidInput, signal: controller.signal }, async () => assert.fail("consumed")), /^Error: SIGNING_CANCELLED$/);
  await assert.rejects(api.withAndroidSigningMaterial({ ...androidInput, credential: { ...credential, fileBase64: "%%%%" } }, async () => assert.fail("consumed")), /^Error: SIGNING_CREDENTIAL_INVALID$/);
});
test("opt-in signing diagnostics identify a fixed operation without exposing tool paths, argv, passwords or output", { skip: !hasKeytool }, async () => {
  const events: NativeSigningDiagnostic[] = []; let failure: unknown;
  try { await api.withAndroidSigningMaterial({ ...androidInput, credential: { ...credential, keyAlias: "foreign" }, onDiagnostic: value => { events.push(value); } }, async () => assert.fail("consumed")); }
  catch (error) { failure = error; }
  assert.equal((failure as { operation?: string }).operation, "keystore-validation");
  assert.deepEqual(events, [
    { diagnostic: true, stage: "native-signing", operation: "keystore-validation", state: "started" },
    { diagnostic: true, stage: "native-signing", operation: "keystore-validation", state: "failed", code: "SIGNING_TOOL_FAILED" },
  ]);
  const serialized = JSON.stringify(events) + JSON.stringify(failure);
  for (const denied of [storePassword, keytool, "foreign", "-srckeystore", fixtures]) assert.ok(!serialized.includes(denied));
});
test("actual codesign certificate extraction uses its optional prefix without interpreting it as a second artifact", { skip: process.platform !== "darwin" }, async () => {
  assert.equal(typeof api.extractIOSSigningCertificate, "function");
  const root = await mkdtemp(join(fixtures, "certificate-extraction-")), events: NativeSigningDiagnostic[] = [];
  const certificate = await api.extractIOSSigningCertificate("/System/Applications/Calculator.app", root, { ...androidInput, onDiagnostic: value => { events.push(value); } });
  assert.doesNotThrow(() => new X509Certificate(certificate));
  const outputFiles = (await readdir(root)).filter(name => name.startsWith("verified-cert-")); assert.ok(outputFiles.length > 0);
  assert.ok(outputFiles.every(name => /^verified-cert-[a-f0-9]{32}-[0-9]+$/.test(name)));
  assert.deepEqual(events, [ { diagnostic: true, stage: "native-signing", operation: "signature-certificate", state: "started" },
    { diagnostic: true, stage: "native-signing", operation: "signature-certificate", state: "succeeded" } ]);
  assert.ok(!JSON.stringify(events).includes(root));
});

test("JSON and non-plist bundle metadata refuse before any signing tool or credential consumption", async () => {
  const root = await mkdtemp(join(fixtures, "invalid-info-")), events: NativeSigningDiagnostic[] = [];
  for (const [index, info] of [JSON.stringify({ CFBundleIdentifier: applicationId, CFBundleExecutable: "Fixture", CFBundleSupportedPlatforms: ["iPhoneOS"] }), "not a property list"].entries()) {
    const app = join(root, `Unsigned${index}.app`), outputApp = join(root, `Signed${index}.app`);
    await mkdir(app); await writeFile(join(app, "Info.plist"), info); await writeFile(join(app, "Fixture"), macho());
    await assert.rejects(api.signIOSApp({ jobId: "ios-invalid-info", appId: "app-fixture", applicationId, expectedCertificateSha256: fixture.sha256, teamId,
      certificate: { fileBase64: "%%%%", password: storePassword }, provisioning: { fileBase64: "%%%%" }, unsignedApp: app, outputApp, temporaryRoot: root,
      onDiagnostic: value => { events.push(value); } }), /^Error: SIGNING_ARTIFACT_INVALID$/);
    await assert.rejects(stat(outputApp), { code: "ENOENT" });
  }
  assert.deepEqual(events, []); assert.ok((await readdir(root)).every(name => name.startsWith("Unsigned")));
});

test("XML and binary app plists remain supported while JSON framework metadata refuses before keys", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(fixtures, "bundle-formats-"));
  for (const format of ["xml1", "binary1"]) {
    const app = join(root, `Unsigned-${format}.app`), info = join(app, "Info.plist"); await mkdir(app);
    await writeFile(info, JSON.stringify({ CFBundleIdentifier: applicationId, CFBundleExecutable: "Fixture", CFBundleSupportedPlatforms: ["iPhoneOS"] }));
    await trustedProcess("/usr/bin/plutil", ["-convert", format, info]); await writeFile(join(app, "Fixture"), macho());
    const input = { jobId: "ios-plist-format", appId: "app-fixture", applicationId, expectedCertificateSha256: fixture.sha256, teamId,
      certificate: { fileBase64: "%%%%", password: storePassword }, provisioning: { fileBase64: "%%%%" }, unsignedApp: app, outputApp: join(root, `Signed-${format}.app`), temporaryRoot: root };
    await assert.rejects(api.signIOSApp(input), /^Error: SIGNING_CREDENTIAL_INVALID$/);
    const framework = join(app, "Frameworks", "Fixture.framework"); await mkdir(framework, { recursive: true });
    await writeFile(join(framework, "Info.plist"), JSON.stringify({ CFBundleExecutable: "Fixture" })); await writeFile(join(framework, "Fixture"), macho(0x0100000c, 2, 6));
    const events: NativeSigningDiagnostic[] = [];
    await assert.rejects(api.signIOSApp({ ...input, onDiagnostic: value => { events.push(value); } }), /^Error: SIGNING_ARTIFACT_INVALID$/);
    assert.ok(events.every(event => !["certificate-decode", "private-key-decode", "keychain-create"].includes(event.operation)));
    await assert.rejects(stat(input.outputApp), { code: "ENOENT" });
  }
  assert.ok((await readdir(root)).every(name => name.startsWith("Unsigned")));
});

test("strict codesign validity alone cannot accept missing, changed or extra app entitlements", { skip: process.platform !== "darwin" }, async () => {
  assert.equal(typeof api.verifyIOSSignedEntitlements, "function");
  const root = await mkdtemp(join(fixtures, "signed-entitlements-")), app = join(root, "Fixture.app"); await mkdir(app);
  const source = join(root, "main.c"), info = join(app, "Info.plist"), entitlementFile = join(root, "entitlements.plist");
  await writeFile(source, "int main(void) { return 0; }\n");
  const sdk = (await trustedProcess("/usr/bin/xcrun", ["--sdk", "iphoneos", "--show-sdk-path"])).trim();
  await trustedProcess("/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang",
    ["-target", "arm64-apple-ios15.0", "-isysroot", sdk, source, "-o", join(app, "Fixture")]);
  await writeFile(info, JSON.stringify({ CFBundleIdentifier: applicationId, CFBundleExecutable: "Fixture", CFBundleSupportedPlatforms: ["iPhoneOS"], CFBundlePackageType: "APPL", CFBundleVersion: "1" }));
  await trustedProcess("/usr/bin/plutil", ["-convert", "xml1", info]);
  const selected = api.selectIOSEntitlements(distributionProfile(), applicationId, teamId,
    { "com.apple.developer.associated-domains": ["applinks:isso.uulab.co.kr"] });
  await trustedProcess("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
  await trustedProcess("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  await assert.rejects(api.verifyIOSSignedEntitlements(app, selected, androidInput), /^Error: SIGNING_ENTITLEMENTS_INVALID$/);
  for (const actual of [selected, { ...selected, "com.apple.developer.team-identifier": "OTHERTEAM1" },
    { ...selected, "application-identifier": teamId + ".kr.co.uulab.other" }, { ...selected, "get-task-allow": true },
    { ...selected, "aps-environment": "development" }, { ...selected, "keychain-access-groups": [teamId + ".kr.co.uulab.other"] },
    { ...selected, "com.apple.developer.associated-domains": ["applinks:foreign.uulab.co.kr"] },
    { ...selected, "com.apple.security.application-groups": ["group.foreign"] }]) {
    await writeFile(entitlementFile, JSON.stringify(actual)); await trustedProcess("/usr/bin/plutil", ["-convert", "xml1", entitlementFile]);
    await trustedProcess("/usr/bin/codesign", ["--force", "--sign", "-", "--entitlements", entitlementFile, "--generate-entitlement-der", "--timestamp=none", app]);
    await trustedProcess("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    if (actual === selected) await api.verifyIOSSignedEntitlements(app, selected, androidInput);
    else await assert.rejects(api.verifyIOSSignedEntitlements(app, selected, androidInput), /^Error: SIGNING_ENTITLEMENTS_INVALID$/);
  }
});

test("actual APK signing verifies app identity and pinned signer while preserving original keystore and APK", { skip: !hasAndroidTools }, async () => {
  assert.equal(typeof api.signAndroidApk, "function");
  const sourceHash = createHash("sha256").update(await readFile(unsignedApk)).digest("hex"), keyHash = createHash("sha256").update(await readFile(keystore)).digest("hex");
  const root = await mkdtemp(join(fixtures, "sign-apk-")), outputApk = join(fixtures, "signed.apk");
  const receipt = await api.signAndroidApk({ ...androidInput, tools: allAndroidTools, unsignedApk, outputApk, temporaryRoot: root });
  assert.equal(receipt.platform, "android"); assert.equal(receipt.applicationId, applicationId); assert.equal(receipt.certificateSha256, androidSha);
  assert.equal(receipt.artifactPath, outputApk); assert.equal(receipt.artifactSha256, createHash("sha256").update(await readFile(outputApk)).digest("hex"));
  const verified = await trustedProcess(join(buildTools, "apksigner"), ["verify", "--print-certs", outputApk]);
  assert.ok(verified.includes(androidSha)); assert.equal((await stat(outputApk)).mode & 0o777, 0o600);
  assert.equal(createHash("sha256").update(await readFile(unsignedApk)).digest("hex"), sourceHash);
  assert.equal(createHash("sha256").update(await readFile(keystore)).digest("hex"), keyHash); assert.deepEqual(await readdir(root), []);
});
test("APK package mismatch and input symlink reject before credential parsing; existing output remains preserved", { skip: !hasAndroidTools }, async () => {
  assert.equal(typeof api.signAndroidApk, "function"); const outputApk = join(fixtures, "existing.apk"); await writeFile(outputApk, "existing-data");
  await assert.rejects(api.signAndroidApk({ ...androidInput, applicationId: "kr.co.uulab.foreign", credential: { ...credential, fileBase64: "%%%%" }, tools: allAndroidTools, unsignedApk, outputApk }), /^Error: SIGNING_ARTIFACT_INVALID$/);
  const link = join(fixtures, "symlink.apk"); await symlink(unsignedApk, link);
  await assert.rejects(api.signAndroidApk({ ...androidInput, tools: allAndroidTools, unsignedApk: link, outputApk }), /^Error: SIGNING_ARTIFACT_INVALID$/);
  await assert.rejects(api.signAndroidApk({ ...androidInput, tools: allAndroidTools, unsignedApk, outputApk }), /^Error: SIGNING_TOOL_FAILED$/);
  assert.equal(await readFile(outputApk, "utf8"), "existing-data");
});
test("self-signed CMS profile is refused before iOS keychain creation with original certs and search list preserved", { skip: process.platform !== "darwin" }, async () => {
  assert.equal(typeof api.withIOSSigningMaterial, "function");
  const before = await trustedProcess("/usr/bin/security", ["list-keychains", "-d", "user"]), root = await mkdtemp(join(fixtures, "sign-ios-"));
  const originalP12 = await readFile(certificateP12), originalProfile = await readFile(signedProfile);
  let consumed = false;
  await assert.rejects(api.withIOSSigningMaterial({ jobId: "ios-fixture", appId: "app-fixture", applicationId, expectedCertificateSha256: fixture.sha256, teamId,
    certificate: { fileBase64: originalP12.toString("base64"), password: storePassword }, provisioning: { fileBase64: originalProfile.toString("base64") }, temporaryRoot: root },
    async () => { consumed = true; }), (error: unknown) => { assert.match((error as Error).message, /^SIGNING_[A-Z_]+$/); assert.ok(!String(error).includes(storePassword)); return true; });
  assert.equal(consumed, false); assert.deepEqual(await readdir(root), []);
  assert.equal(await trustedProcess("/usr/bin/security", ["list-keychains", "-d", "user"]), before);
  assert.deepEqual(await readFile(certificateP12), originalP12); assert.deepEqual(await readFile(signedProfile), originalProfile);
});

function macho(cpu = 0x0100000c, platform = 2, fileType = 2): Buffer {
  const value = Buffer.alloc(56); value.writeUInt32LE(0xfeedfacf, 0); value.writeUInt32LE(cpu, 4); value.writeUInt32LE(fileType, 12);
  value.writeUInt32LE(1, 16); value.writeUInt32LE(24, 20); value.writeUInt32LE(0x32, 32); value.writeUInt32LE(24, 36); value.writeUInt32LE(platform, 40); return value;
}
test("device Mach-O validator accepts arm64 iOS and refuses simulator, other CPUs, malformed commands and foreign file types", () => {
  assert.equal(typeof api.validateIOSMachO, "function"); assert.doesNotThrow(() => api.validateIOSMachO(macho(), "executable"));
  assert.doesNotThrow(() => api.validateIOSMachO(macho(0x0100000c, 2, 6), "library"));
  for (const value of [macho(0x0100000c, 7), macho(0x01000007, 2), macho(0x0100000c, 1), macho(0x0100000c, 2, 1), Buffer.alloc(32), macho().subarray(0, 40)]) {
    assert.throws(() => api.validateIOSMachO(value, "executable"), /^Error: SIGNING_ARTIFACT_INVALID$/);
  }
});
