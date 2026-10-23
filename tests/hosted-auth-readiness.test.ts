import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

// Exercise the actual QA helper against production auth bootstrap with metadata
// deliberately held. Synthetic DOM timing test; real Chromium remains a CI check.
test("hosted authentication retains credentials when auth metadata arrives after page navigation", async () => {
  const authModule = "../packages/cloudflare/public/auth.js";
  const { bootstrapAuth } = await import(authModule);
  const capture = await readFile(new URL("../scripts/hosted-qa/capture.mjs", import.meta.url), "utf8");
  const start = capture.indexOf("  async function authenticate("), end = capture.indexOf("  async function cookieProof(", start);
  assert.ok(start >= 0 && end > start);
  for (const setup of [true, false]) {
    const nodes = new Map<string, any>();
    const node = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { value: "", disabled: ["auth-submit", "token", "confirmation"].includes(id),
        setAttribute() {}, addEventListener() {} });
      return nodes.get(id);
    };
    const harness = { email: "owner@example.test", password: "synthetic password 🙂", token: "X".repeat(43) };
    let release!: (response: Response) => void, received!: (response: { status(): number }) => void;
    const metadata = new Promise<Response>(resolve => { release = resolve; });
    const reply = new Promise<{ status(): number }>(resolve => { received = resolve; });
    const posts: any[] = [];
    const bootstrap = bootstrapAuth({ document: { getElementById: node }, location: { pathname: setup ? "/setup" : "/login" },
      fetch: async (path: string, init: RequestInit) => {
        if (path === "/api/auth/options") return metadata;
        assert.equal(path, "/api/auth/" + (setup ? "enroll" : "login"));
        posts.push(JSON.parse(init.body as string)); received({ status: () => 403 });
        return Response.json({ error: "FORBIDDEN" }, { status: 403 });
      } });
    const ready = async () => { release(Response.json({})); return bootstrap; };
    const page = {
      locator(selector: string) {
        const id = selector.slice(1).replace(":enabled", "");
        return {
          waitFor: async () => { assert.equal(selector, "#auth-submit:enabled"); await ready(); assert.equal(node(id).disabled, false); },
          fill: async (value: string) => { if (node(id).disabled) await ready(); node(id).value = value; },
          click: async () => { await (await ready()).submit(); assert.equal(posts.length, 1, "Metadata bootstrap cleared an early password before submission"); },
        };
      },
      waitForResponse: () => reply,
    };
    const authenticate = runInNewContext(capture.slice(start, end) + "\nauthenticate", { harness, URL });
    assert.equal((await authenticate(page, setup)).status(), 403);
    assert.equal(posts[0].password, harness.password);
    assert.equal(node("password").value, "");
    if (setup) assert.equal(posts[0].confirmation, harness.password);
    (await bootstrap).close();
  }
});
