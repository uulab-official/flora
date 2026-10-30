import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createTestRuntime } from "./runtime.ts";
import { HttpFailure, routeRequest } from "../dist/http.js";

const origin = "https://flora.example.test";
const appId = "application_12345678-abcd-4321-1234-123456789abc";
const pages = [`/apps/${appId}/ota/b877e6bc-902e-487b-985d-82f179f9ad64/unresolved`, `/apps/${appId}/ota/b877e6bc-902e-487b-985d-82f179f9ad64/resolved`, "/", "/projects", "/projects/new", "/settings", `/apps/${appId}/ota/b877e6bc-902e-487b-985d-82f179f9ad64/issues`, `/apps/${appId}`,
  ...["source", "ota", "runners", "builds", "credentials", "settings", "activity"].map(page => `/apps/${appId}/${page}`)];

test("explicit admin documents are admitted with no fallback or changed body rules", () => {
  for (const path of pages) {
    assert.equal(routeRequest(new Request(origin + path)).path, "/index.html");
    assert.equal(routeRequest(new Request(origin + path)).kind, "private-asset");
    for (const method of ["POST", "HEAD", "OPTIONS"]) assert.throws(() => routeRequest(new Request(origin + path, { method })), (error: unknown) => error instanceof HttpFailure && error.status === 405);
    assert.throws(() => routeRequest(new Request(origin + path + "?appId=another_app")), (error: unknown) => error instanceof HttpFailure && error.status === 400);
    assert.throws(() => routeRequest(new Request(origin + path, { headers: { "Content-Length": "1" } })), (error: unknown) => error instanceof HttpFailure && error.status === 400);
  }
  for (const path of ["/projects/", "/projects/unknown", "/project", "/apps", "/apps/ab", "/apps/UPPER_APP", `/apps/${appId}/unknown`, `/apps/${appId}/credentials/secret`, "/api/unknown", "/%70rojects", "/index.html"]) {
    assert.throws(() => routeRequest(new Request(origin + path)), (error: unknown) => error instanceof HttpFailure && error.status === 404, path);
  }
  assert.equal(routeRequest(new Request(origin + "/admin-routes.js")).kind, "public-asset");
});

test("build provider source is a private authenticated module and cannot accept mutations", () => {
  const route = routeRequest(new Request(origin + "/build-provider-panel.js"));
  assert.equal(route.path, "/build-provider-panel.js");
  assert.equal(route.kind, "private-asset");
  for (const method of ["POST", "PUT", "HEAD", "OPTIONS"]) assert.throws(
    () => routeRequest(new Request(origin + "/build-provider-panel.js", { method })),
    (error: unknown) => error instanceof HttpFailure && error.status === 405
  );
  for (const path of ["/build-provider-panel.js?token=exposed", "/build-provider-panel.js/extra", "/%62uild-provider-panel.js"])
    assert.throws(() => routeRequest(new Request(origin + path)), (error: unknown) =>
      error instanceof HttpFailure && [400, 404].includes(error.status));
});

test("login accepts only canonical admin return paths and setup retains strict query rejection", async () => {
  const { authReturnPath } = await import(new URL("../public/auth.js", import.meta.url).href);
  for (const path of pages) {
    const search = "?returnTo=" + encodeURIComponent(path);
    assert.equal(routeRequest(new Request(origin + "/login" + search)).path, "/auth.html");
    assert.equal(authReturnPath({ pathname: "/login", search }), path === "/" ? "/projects" : path);
  }
  for (const value of ["https://evil.example/projects", "//evil.example/projects", "/projects?x=1", "/projects#fragment", "/projects/../settings", "/projects/", "%2fprojects", "/apps/ab", "/api/state", "/\\evil.example"]) {
    const search = "?returnTo=" + encodeURIComponent(value);
    assert.throws(() => routeRequest(new Request(origin + "/login" + search)), (error: unknown) => error instanceof HttpFailure && error.status === 400, value);
    assert.equal(authReturnPath({ pathname: "/login", search }), "/", value);
  }
  for (const search of ["?returnTo=", "?returnTo=%2Fprojects&returnTo=%2Fsettings", "?returnTo=%2Fprojects&unknown=1", "?x=1"]) {
    assert.throws(() => routeRequest(new Request(origin + "/login" + search)), (error: unknown) => error instanceof HttpFailure && error.status === 400);
    assert.equal(authReturnPath({ pathname: "/login", search }), "/");
  }
  assert.equal(authReturnPath({ pathname: "/setup", search: "?returnTo=%2Fsettings" }), "/");
  assert.equal(authReturnPath({ pathname: "/login", search: "?returnTo=%2Fsettings", hash: "#bad" }), "/");
  assert.throws(() => routeRequest(new Request(origin + "/setup?returnTo=%2Fprojects")), (error: unknown) => error instanceof HttpFailure && error.status === 400);
});

test("admin document deep links require live authority and preserve safe login destinations", async t => {
  const token = randomBytes(32), password = randomBytes(24).toString("base64url"), now = 1_800_000_000_000;
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/hosted-entry.ts", import.meta.url), durableObjects: { FLORA_AUTH: "HostedFixtureAuth" }, bindings: {
    FLORA_ORIGIN: origin, FLORA_OWNER_ID: "synthetic-owner", FLORA_OWNER_EMAIL: "owner@example.test", FLORA_DB_IDENTITY: "synthetic-db",
    FLORA_SETUP: { digest: createHash("sha256").update(token).digest("hex"), issuedAt: now, expiresAt: now + 600000, generation: 1, purpose: "enroll" },
  }});
  t.after(() => runtime.dispose());
  const migrations = await Promise.all(["0001_private_imports.sql", "0002_multi_app.sql", "0003_github_ota.sql", "0004_automation.sql"].map(file => readFile(new URL("../migrations/" + file, import.meta.url), "utf8")));
  await runtime.d1.exec(migrations.join("\n").replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|PRAGMA|$)/).filter(s => s.trim()).map(s => s.replace(/\s*\n\s*/g, " ").trim() + ";").join("\n"));
  await runtime.d1.prepare("INSERT INTO flora_deployment(singleton,owner_id,origin,db_identity) VALUES(1,?,?,?)").bind("synthetic-owner", origin, "synthetic-db").run();
  const enrolled = await runtime.fetch(origin + "/api/auth/enroll", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.test", password, confirmation: password, token: token.toString("base64url") }) });
  assert.equal(enrolled.status, 200);
  const cookie = enrolled.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  const { csrfToken } = await enrolled.json() as { csrfToken: string };
  for (const path of pages) {
    const unauthenticated = await runtime.fetch(origin + path, { redirect: "manual" });
    assert.equal(unauthenticated.status, 302);
    assert.equal(unauthenticated.headers.get("Location"), path === "/" ? "/login" : "/login?returnTo=" + encodeURIComponent(path));
    assert.equal(unauthenticated.headers.get("Cache-Control"), "no-store");
    assert.doesNotMatch(await unauthenticated.text(), /PRIVATE_ASSET|synthetic-owner/);
    const authenticated = await runtime.fetch(origin + path, { headers: { Cookie: cookie } });
    assert.equal(authenticated.status, 200);
    assert.equal(await authenticated.text(), "PRIVATE_ASSET");
  }
  assert.equal((await runtime.fetch(origin + "/admin-routes.js")).status, 200);
  const logout = await runtime.fetch(origin + "/api/auth/logout", { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-Flora-CSRF": csrfToken }, body: "{}" });
  assert.equal(logout.status, 200);
  const revoked = await runtime.fetch(origin + `/apps/${appId}/credentials`, { redirect: "manual", headers: { Cookie: cookie } });
  assert.equal(revoked.status, 302);
  assert.doesNotMatch(await revoked.text(), /PRIVATE_ASSET/);
  assert.equal((await runtime.fetch(origin + "/app.js", { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await runtime.fetch(origin + `/apps/${appId}/unknown`)).status, 404);
});

test("successful login resumes only its validated destination and clears credentials", async () => {
  const { startAuth } = await import(new URL("../public/auth.js", import.meta.url).href);
  for (const destination of [`/apps/${appId}/ota`, "//evil.example/projects"]) {
    const nodes = new Map<string, any>();
    const document = { getElementById(id: string) {
      if (!nodes.has(id)) nodes.set(id, { value: "", hidden: false, disabled: false, textContent: "", setAttribute() {}, addEventListener() {} });
      return nodes.get(id);
    } };
    const navigations: string[] = [];
    const auth = startAuth({ document, location: { pathname: "/login", search: "?returnTo=" + encodeURIComponent(destination), replace(path: string) { navigations.push(path); } }, now: () => 100,
      fetch: async () => ({ ok: true, json: async () => ({ csrfToken: "synthetic-csrf", expiresAt: 1000 }) }) });
    document.getElementById("email").value = "owner@example.test";
    document.getElementById("password").value = "synthetic-login-password";
    await auth.submit();
    assert.deepEqual(navigations, [destination.startsWith("/apps/") ? destination : "/"]);
    for (const id of ["email", "password", "confirmation", "token"]) assert.equal(document.getElementById(id).value, "");
  }
});

test('gallery assets and bounded installation icons stay authenticated GET-only routes',()=>{
 for(const path of ['/project-gallery.css','/project-branding.js','/project-icons/mobile.png','/project-icons/app-2.webp']){
  const route=routeRequest(new Request(origin+path));assert.equal(route.kind,'private-asset');assert.equal(route.path,path);
  assert.throws(()=>routeRequest(new Request(origin+path,{method:'POST'})),(e:unknown)=>e instanceof HttpFailure&&e.status===405);
 }
 for(const path of ['/project-icons/../private.json','/project-icons/%2e%2e%2fsecret.png','/project-icons/a.svg','/project-icons/a.png/extra'])assert.throws(()=>routeRequest(new Request(origin+path)),(e:unknown)=>e instanceof HttpFailure&&e.status===404);
});
