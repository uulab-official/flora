import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createGitHubResolver, createGitHubAutomationSourceProvider, isGitHubInstallationToken } from "@app-ops/dogfood";
import type { GitHubConnection } from "../src/operations.ts";

const connection: GitHubConnection = { appId: "app_test", version: 1, installationId: 12, owner: "uulab-official", repository: "expo-app", ref: "main", connectedAt: 1 };
const sha = "a".repeat(40);
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
function fixture(dynamic = false, override?: (url: URL) => Response | null | Promise<Response | null>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push({ url, init: init! });
    const custom = await override?.(url); if (custom) return custom;
    if (url.pathname === "/app/installations/12/access_tokens") return Response.json({ token: "private-installation-token" });
    if (url.pathname === "/repos/uulab-official/expo-app") return Response.json({ full_name: "uulab-official/expo-app" });
    if (url.pathname === "/repos/uulab-official/expo-app/commits") return Response.json([{ sha }]);
    if (url.pathname.endsWith("/commits/main")) return Response.json({ sha });
    if (url.pathname.endsWith("/contents")) return Response.json(["package.json", "app.json", ...(dynamic ? ["app.config.ts"] : [])].map(name => ({ name, type: "file" })));
    const content = url.pathname.endsWith("package.json") ? { dependencies: { expo: "~56.0.0", "react-native": "0.85.0", "expo-updates": "~0.30.0" } } : { expo: { runtimeVersion: "native-1", platforms: ["ios", "android"], updates: { enabled: true, url: "https://updates.example.test/updates/app_test" } } };
    const bytes = Buffer.from(JSON.stringify(content));
    return Response.json({ type: "file", encoding: "base64", size: bytes.length, content: bytes.toString("base64") });
  };
  return { calls, resolver: createGitHubResolver({ credentials: { appId: "123", privateKey: key }, fetch: request as typeof fetch, now: () => 1_800_000_000_000 }) };
}
test("GitHub App detection pins the ref before all bounded config reads and outputs no credentials", async () => {
  const { resolver, calls } = fixture(); const detected = await resolver.detect(connection, ".");
  assert.equal(detected.commitSha, sha); assert.equal(detected.framework, "expo"); assert.equal(detected.updatesEnabled, true); assert.equal(detected.runtimeVersion, "native-1");
  assert.ok(calls.slice(2).every(call => call.url.searchParams.get("ref") === sha));
  assert.ok(calls.every(call => call.url.origin === "https://api.github.com" && call.init.redirect === "manual" && call.init.signal));
  const jwt = new Headers(calls[0]!.init.headers).get("Authorization")!.slice(7).split(".");
  const payload = JSON.parse(Buffer.from(jwt[1]!, "base64url").toString()); assert.equal(payload.iss, "123"); assert.ok(payload.exp - payload.iat <= 600);
  assert.doesNotMatch(JSON.stringify(detected), /private-installation-token|PRIVATE KEY|postinstall/);
});
test("dynamic config is never executed and requires a pinned exported resolved config", async () => {
  const { resolver, calls } = fixture(true); const blocked = await resolver.detect(connection, ".");
  assert.equal(blocked.configSource, "dynamic-required"); assert.equal(blocked.updatesEnabled, false);
  assert.ok(calls.every(call => !call.url.pathname.endsWith("app.config.ts")));
  await assert.rejects(resolver.detect(connection, ".", { commitSha: "b".repeat(40), config: {} }));
  const detected = await resolver.detect(connection, ".", { commitSha: sha, config: { runtimeVersion: "native-1", updates: { url: "https://updates.example.test/updates/app_test" } } });
  assert.equal(detected.configSource, "resolved-export"); assert.equal(detected.updatesEnabled, true);
});
test("provider redirects and errors cannot leak token-bearing response content", async () => {
  const { resolver } = fixture(false, url => url.pathname.endsWith("/commits/main") ? new Response("private-installation-token", { status: 302, headers: { Location: "https://evil.test" } }) : null);
  await assert.rejects(resolver.detect(connection, "."), (error: Error) => { assert.equal(error.message, "PROVIDER_UNSUPPORTED"); return true; });
});
test("confirmed GitHub access denial returns a safe typed code without provider content", async () => {
  const { resolver } = fixture(false, url => url.pathname.endsWith("/access_tokens") ? Response.json({ message: "Resource not accessible by integration", token: "private-installation-token", documentation_url: "https://secret.example" }, { status: 403 }) : null);
  await assert.rejects(resolver.detect(connection, "."), (error: Error & { code?: string }) => {
    assert.equal(error.code, "GITHUB_ACCESS_DENIED"); assert.equal(error.message, "GITHUB_ACCESS_DENIED");
    assert.doesNotMatch(JSON.stringify(error), /token|secret\.example|integration/); return true;
  });
});
test("unavailable installation repository stays distinct from unproven permissions", async () => {
  for (const status of [404, 422]) {
    const { resolver } = fixture(false, url => url.pathname.endsWith("/access_tokens") ? new Response("private-installation-token", { status }) : null);
    await assert.rejects(resolver.detect(connection, "."), { code: "GITHUB_REPOSITORY_UNAVAILABLE" });
  }
});
test("missing configured ref is reported only after repository identity and read access are confirmed", async () => {
  const { resolver, calls } = fixture(false, url => url.pathname.endsWith("/commits/main") ? new Response("private-installation-token", { status: 404 }) : null);
  await assert.rejects(resolver.detect(connection, "."), { code: "GITHUB_REF_NOT_FOUND" });
  assert.equal(calls[2]!.url.pathname, "/repos/uulab-official/expo-app");
  assert.equal(calls[3]!.url.pathname, "/repos/uulab-official/expo-app/commits");
  assert.equal(calls[3]!.url.searchParams.get("per_page"), "1");
  assert.ok(calls.every(call => !call.url.pathname.includes("/contents")));
  for (const metadata of [new Response("not found", { status: 404 }), Response.json({ full_name: "different/repository" })]) {
    const { resolver: unconfirmed } = fixture(false, url => url.pathname.endsWith("/commits/main") ? new Response("not found", { status: 404 }) : url.pathname === "/repos/uulab-official/expo-app" ? metadata : null);
    await assert.rejects(unconfirmed.detect(connection, "."), { code: metadata.status === 404 ? "GITHUB_REPOSITORY_UNAVAILABLE" : "PROVIDER_UNSUPPORTED" });
  }
  const { resolver: metadataOnly } = fixture(false, url => url.pathname.endsWith("/commits/main") || url.pathname === "/repos/uulab-official/expo-app/commits" ? new Response("not found", { status: 404 }) : null);
  await assert.rejects(metadataOnly.detect(connection, "."), { code: "GITHUB_REPOSITORY_UNAVAILABLE" });
});
test("GitHub rate limits and unknown forbidden responses remain provider failures", async () => {
  for (const headers of [{ "X-RateLimit-Remaining": "0" }, { "Retry-After": "60" }]) for (const status of [403, 404, 422]) {
    const { resolver } = fixture(false, url => url.pathname.endsWith("/access_tokens") ? Response.json({ message: "Resource not accessible by integration" }, { status, headers }) : null);
    await assert.rejects(resolver.detect(connection, "."), { code: "PROVIDER_UNSUPPORTED" });
  }
  for (const status of [403, 429, 500, 502, 503]) {
    const { resolver } = fixture(false, url => url.pathname.endsWith("/access_tokens") ? Response.json({ message: "synthetic provider detail", token: "private-installation-token" }, { status }) : null);
    await assert.rejects(resolver.detect(connection, "."), { code: "PROVIDER_UNSUPPORTED" });
  }
});
test("missing package manifest reports unsupported app instead of a provider outage", async () => {
  const { resolver } = fixture(false, url => url.pathname.endsWith("/contents") ? Response.json([{ name: "README.md", type: "file" }]) : null);
  await assert.rejects(resolver.detect(connection, "."), { code: "GITHUB_APP_UNSUPPORTED" });
});
test("platform runtime and update overrides cannot claim the shared native compatibility", async () => {
  for (const override of [{ runtimeVersion: "different-native" }, { runtimeVersion: { policy: "fingerprint" } }, { updates: { url: "https://other.example.test" } }, { updates: { enabled: false } }]) {
    const { resolver } = fixture(false, url => {
      if (!url.pathname.endsWith("/app.json")) return null;
      const bytes = Buffer.from(JSON.stringify({ expo: { runtimeVersion: "native-1", ios: override, updates: { enabled: true, url: "https://updates.example.test/updates/app_test" } } }));
      return Response.json({ type: "file", encoding: "base64", size: bytes.length, content: bytes.toString("base64") });
    });
    const detected = await resolver.detect(connection, ".");
    assert.equal(detected.updatesEnabled, false, JSON.stringify(override));
    assert.ok(detected.reasons.includes("PLATFORM_RUNTIME_UNRESOLVED"));
  }
});
test("stalled provider body is bounded even when its stream ignores abort", { timeout: 500 }, async () => {
  const request = async () => new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } }, { highWaterMark: 0 }));
  const resolver = createGitHubResolver({ credentials: { appId: "123", privateKey: key }, fetch: request as typeof fetch, now: () => 1_800_000_000_000, timeoutMs: 30 });
  const began = performance.now();
  await assert.rejects(resolver.detect(connection, "."), { code: "PROVIDER_UNSUPPORTED" });
  assert.ok(performance.now() - began < 400);
});
test("source-bound Flora SDK target needs no Expo framework or EAS account", async () => {
  const target = { schemaVersion: 1, ota: { runtimeVersion: "flora-native-1", platforms: ["android"], url: "https://updates.example.test/updates/app_test" }, export: { bundler: "metro", entryFile: "index.js", nodeVersion: "24.19.0", packageManager: { name: "npm", version: "11.9.0" } } };
  const { resolver } = fixture(false, url => {
    if (url.pathname.endsWith("/contents")) return Response.json(["package.json", "flora.config.json", "app.config.ts"].map(name => ({ name, type: "file" })));
    const data = url.pathname.endsWith("/package.json") ? { dependencies: { "@flora/ota": "workspace:*" } } : url.pathname.endsWith("/flora.config.json") ? target : null;
    if (!data) return null; const bytes = Buffer.from(JSON.stringify(data)); return Response.json({ type: "file", encoding: "base64", size: bytes.length, content: bytes.toString("base64") });
  });
  const detected = await resolver.detect(connection, ".");
  assert.equal(detected.framework, "flora"); assert.equal(detected.configSource, "flora.config.json"); assert.equal(detected.updatesEnabled, true); assert.equal(detected.runtimeVersion, "flora-native-1");
  assert.equal(detected.automationConfig!.bundler, "metro");
  assert.equal(detected.expoVersion, null); assert.doesNotMatch(JSON.stringify(detected), /"eas"|"projectId"/i);
});
test("source provider grants repo-read credentials for the pinned SHA with bounded lifetime", async () => {
  const now = 1_800_000_000_000;
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchSource = async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init: init! }); return Response.json({ token: "private_source_token", expires_at: new Date(now + 3_600_000).toISOString() }, { status: 201 }); };
  const source = createGitHubAutomationSourceProvider({ credentials: { appId: "123", privateKey: key }, fetch: fetchSource as typeof fetch, now: () => now });
  const grant = await source.grant(connection, sha, now + 60_000);
  assert.equal(grant.url, `https://api.github.com/repos/${connection.owner}/${connection.repository}/tarball/${sha}`); assert.equal(grant.commitSha, sha); assert.equal(grant.expiresAt, now + 60_000); assert.equal(grant.token, "private_source_token");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { repositories: [connection.repository], permissions: { contents: "read" } }); assert.equal(calls[0]!.init.redirect, "manual");
  assert.doesNotMatch(JSON.stringify(grant), /PRIVATE KEY|privateKey|publish/);
});
test("opaque legacy and stateless installation tokens remain bearer-safe and bounded", async () => {
  const stateless = "ghs_5283312_" + Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url") + "." + Buffer.from(JSON.stringify({ repositories: Array.from({ length: 40 }, (_, index) => index), scope: "synthetic".repeat(80) })).toString("base64url") + "." + "signature".repeat(40);
  assert.ok(stateless.length > 512 && stateless.length < 4096);
  for (const token of ["ghs_" + "legacy".repeat(7), stateless, "opaque._~+/-==", "a".repeat(4096)]) {
    assert.equal(isGitHubInstallationToken(token), true);
    const { resolver, calls } = fixture(false, url => url.pathname.endsWith("/access_tokens") ? Response.json({ token }) : null);
    const detected = await resolver.detect(connection, "."); assert.equal(detected.commitSha, sha);
    assert.ok(calls.slice(1).every(call => new Headers(call.init.headers).get("Authorization") === "Bearer " + token));
    assert.ok(!JSON.stringify(detected).includes(token));
    const source = createGitHubAutomationSourceProvider({ credentials: { appId: "123", privateKey: key }, now: () => 1_800_000_000_000,
      fetch: async () => Response.json({ token, expires_at: new Date(1_800_003_600_000).toISOString() }, { status: 201 }) });
    assert.equal((await source.grant(connection, sha, 1_800_000_060_000)).token, token);
  }
  for (const token of ["", "a".repeat(4097), "ghs_crlf\r\nX-Injected: yes", "ghs space", "ghs\tvalue", "ghs=infix", "ghs\"quoted", null]) {
    assert.equal(isGitHubInstallationToken(token), false);
    const { resolver, calls } = fixture(false, url => url.pathname.endsWith("/access_tokens") ? Response.json({ token }) : null);
    await assert.rejects(resolver.detect(connection, "."), { code: "PROVIDER_UNSUPPORTED" }); assert.equal(calls.length, 1);
    const source = createGitHubAutomationSourceProvider({ credentials: { appId: "123", privateKey: key }, now: () => 1_800_000_000_000,
      fetch: async () => Response.json({ token, expires_at: new Date(1_800_003_600_000).toISOString() }, { status: 201 }) });
    await assert.rejects(source.grant(connection, sha, 1_800_000_060_000), { code: "PROVIDER_UNSUPPORTED" });
  }
});
test("push detection rejects delayed SHA before reading source files when configured ref has moved", async () => {
  const { resolver, calls } = fixture();
  await assert.rejects(resolver.detect(connection, ".", undefined, "b".repeat(40)), { code: "CONFIG_CONFLICT" });
  assert.equal(calls.length, 2, "Only installation token and configured branch HEAD may be read");
  assert.ok(calls.every(call => !call.url.pathname.includes("/contents")));
});
test("push detection rechecks the same configured ref after held pinned source reads", async () => {
  let head = sha, release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { started = resolve; });
  const { resolver, calls } = fixture(false, async url => {
    if (url.pathname.endsWith("/commits/main")) return Response.json({ sha: head });
    if (url.pathname.endsWith("/package.json")) { started(); await held; }
    return null;
  });
  const pending = resolver.detect(connection, ".", undefined, sha); await began;
  head = "b".repeat(40); release();
  await assert.rejects(pending, { code: "CONFIG_CONFLICT" });
  const heads = calls.filter(call => call.url.pathname.endsWith("/commits/main")); assert.equal(heads.length, 2);
  assert.equal(new Headers(heads[0]!.init.headers).get("Authorization"), new Headers(heads[1]!.init.headers).get("Authorization"));
  assert.ok(calls.filter(call => call.url.pathname.includes("/contents")).every(call => call.url.searchParams.get("ref") === sha));
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/access_tokens")).length, 1);
});
