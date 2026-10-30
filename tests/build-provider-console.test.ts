import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildProviderPreview, BUILD_PROVIDER_OPTIONS, createBuildProviderConsole } from "../packages/cloudflare/public/project-views.js";

test("all provider choices are explicit guidance, never a connected build receipt", () => {
  const keys = Object.keys(BUILD_PROVIDER_OPTIONS);
  assert.deepEqual(keys, ["flora-native", "local-script", "github-hosted", "github-selfhosted", "expo-eas", "codemagic", "bitrise"]);
  for (const key of keys) for (const platform of ["android", "ios"]) {
    const info = buildProviderPreview(key, platform, "preview");
    assert.equal(info?.key, key);
    assert.equal(info?.docs.startsWith("https://github.com/uulab-official/flora/"), true);
    assert.equal(info?.intro.includes("Flora가 실행하지 않"), true);
    assert.ok(typeof info?.guidance === "string" && info.guidance.length > 10);
    assert.doesNotMatch(info.command, /EXPO_TOKEN=|BITRISE_API_TOKEN=|CODEMAGIC_API_TOKEN=|secrets: inherit|curl.*-H/i);
  }
  assert.equal(buildProviderPreview("unknown", "ios", "preview"), null);
  assert.equal(buildProviderPreview("codemagic", "web", "preview"), null);
  assert.equal(buildProviderPreview("codemagic", "ios", "paid-production"), null);
});

test("GitHub-hosted and self-hosted build plans run in private caller context only on explicit CLI use", () => {
  const hosted = buildProviderPreview("github-hosted", "ios", "production");
  const own = buildProviderPreview("github-selfhosted", "android", "preview");
  assert.equal(hosted?.usable, true);
  assert.match(hosted?.command ?? "", /gh workflow run flora-build\.yml --ref main -f platform=ios -f profile=production -f runner-type=github-hosted/);
  assert.match(own?.command ?? "", /-f runner-type=self-hosted/);
  assert.ok(!hosted?.command.includes("uulab-official/flora -R"));
  const localUnsigned = buildProviderPreview("local-script", "android", "production");
  assert.equal(localUnsigned?.usable, false);
  assert.equal(localUnsigned?.command, "");
  const local = buildProviderPreview("local-script", "android", "preview");
  assert.match(local?.command ?? "", /node scripts\/flora-expo-build\.mjs android/);
  assert.match(buildProviderPreview("local-script", "ios", "production")?.guidance ?? "", /Xcode/);
});

test("external plans are dry-run by default and require user-owned credentials only outside the dashboard", () => {
  for (const provider of ["expo-eas", "codemagic", "bitrise"]) {
    const guide = buildProviderPreview(provider, "ios", "preview");
    assert.equal(guide?.usable, true);
    assert.match(guide?.command ?? "", /providers (eas|codemagic|bitrise) start/);
    assert.doesNotMatch(guide?.command ?? "", /--execute|--token|-[Kk]ey|Bearer/i);
  }
});

function fakePanel() {
  const ids = ["build-provider-choice", "build-provider-platform", "build-provider-profile",
    "build-provider-app", "build-provider-description", "build-provider-command",
    "build-provider-copy", "build-provider-status"];
  const controls = Object.fromEntries(ids.map(id => [id, {
    value: id === "build-provider-choice" ? "github-hosted" : id === "build-provider-platform" ? "android" : "preview",
    textContent: "", disabled: false, listeners: new Map<string, (value?: unknown) => void>(),
    addEventListener(type: string, handler: (value?: unknown) => void) { this.listeners.set(type, handler); },
    dispatch(type: string) { this.listeners.get(type)?.(); },
  }]));
  let selectedApp: string | null = "app_synthetic";
  let authenticated = true;
  let pending: (() => void) | null = null;
  let calls = 0;
  const env = { document: { getElementById(id: string) { return controls[id]; } },
    navigator: { clipboard: { writeText(_message: string) { calls++;
      return new Promise<void>(resolve => { pending = () => resolve(); });
    } } } };
  const scope = { appId: () => selectedApp, ready: () => authenticated };
  const panel = createBuildProviderConsole(env as unknown as Parameters<typeof createBuildProviderConsole>[0], scope);
  return { panel, controls, get calls() { return calls; }, complete() { pending?.(); pending = null; },
    setApp(value: string | null) { selectedApp = value; },
    logout() { authenticated = false; },
  };
}

test("web provider chooser never executes remote builds; changing app or logging out clears private guidance", async () => {
  const state = fakePanel();
  assert.match(state.controls["build-provider-command"]!.textContent, /gh workflow run/);
  assert.equal(state.controls["build-provider-copy"]!.disabled, false);
  state.controls["build-provider-copy"]!.dispatch("click");
  assert.equal(state.calls, 1);
  state.setApp("app_next");
  state.panel.render();
  state.complete();
  await Promise.resolve();
  assert.doesNotMatch(state.controls["build-provider-status"]!.textContent, /복사 완료/);
  state.controls["build-provider-choice"]!.value = "local-script";
  state.controls["build-provider-profile"]!.value = "production";
  state.controls["build-provider-choice"]!.dispatch("change");
  assert.equal(state.controls["build-provider-copy"]!.disabled, true);
  assert.equal(state.controls["build-provider-command"]!.textContent, "");
  state.logout();
  state.panel.clear();
  state.panel.render();
  assert.equal(state.controls["build-provider-copy"]!.disabled, true);
  assert.equal(state.controls["build-provider-app"]!.textContent, "앱을 선택한 뒤 연결 방법을 확인하세요.");
  assert.equal(state.controls["build-provider-command"]!.textContent, "");
});

test("hosted page serves a bounded, token-free copy-only provider chooser with required DOM IDs", () => {
  const html = readFileSync("packages/cloudflare/public/index.html", "utf8");
  const app = readFileSync("packages/cloudflare/public/app.js", "utf8");
  for (const id of ["build-provider-picker", "build-provider-choice", "build-provider-platform",
    "build-provider-profile", "build-provider-app", "build-provider-description",
    "build-provider-command", "build-provider-copy", "build-provider-status"]) assert.match(html, new RegExp('id="' + id + '"'));
  assert.match(app, /createBuildProviderConsole/);
  assert.ok(!html.includes("input type=\"password\" name=\"provider\""));
  assert.ok(!html.includes("runBuildProvider("));
});
