import { DurableObject } from "cloudflare:workers";
import { R2OTAAssets } from "../../src/r2-assets.js";
import { prepareOTAAsset } from "@app-ops/dogfood";
class TestR2 extends DurableObject {
  assets;
  failure = "";
  revoked = false;
  clock = Date.UTC(2026, 9, 17);
  gates = [];
  holdGets = false;
  calls = { put: 0, get: 0, cancel:0 };
  standardVersions = /* @__PURE__ */ new Map();
  // Miniflare 5.20261006 returns storageClass:"" even for an explicit Standard
  // put. Normalize only that exact local defect for the version we just wrote.
  // Production checks remain strict; actual Standard metadata needs live proof.
  standard(object) {
    if (object && String(object.storageClass) === "" && this.standardVersions.get(object.key) === object.version) Object.defineProperty(object, "storageClass", { value: "Standard" });
    return object;
  }
  constructor(ctx, env) {
    super(ctx, env);
    this.makeAssets = () => new R2OTAAssets({sql:ctx.storage.sql,transactionSync:callback=>ctx.storage.transactionSync(callback),sync:async()=>{await ctx.storage.sync();if(this.failure==="sync-fence")this.revoked=true;if(this.failure==="sync-rollover")this.clock=Date.UTC(2026,10,1);}}, {
      put: async (...args) => {
        this.calls.put++;
        if (this.failure === "before-put") throw Error("private-canary");
        const result = await env.BUCKET.put(...args);
        if (result && args[2]?.storageClass === "Standard") this.standardVersions.set(result.key, result.version);
        if (this.failure === "after-put") throw Error("private-canary");
        if (this.failure === "put-fence") this.revoked = true;
        return this.standard(result);
      },
      get: async (...args) => {
        this.calls.get++;
        if(this.holdGets)await new Promise(resolve=>this.gates.push(resolve));
        if (this.failure === "get") throw Error("private-canary");
        if (this.failure === "missing") return null;
        const result = await env.BUCKET.get(...args);
        if(result){const reader=result.body.getReader(),self=this;Object.defineProperty(result,"body",{value:new ReadableStream({async pull(controller){const part=await reader.read();if(part.done)controller.close();else controller.enqueue(part.value);},async cancel(){self.calls.cancel++;await reader.cancel();}},{highWaterMark:0})});}
        if (result && this.failure === "infrequent") Object.defineProperty(result, "storageClass", { value: "InfrequentAccess" });
        if (result && this.failure === "version") Object.defineProperty(result, "version", { value: "different-version" });
        if (result && this.failure === "checksum") Object.defineProperty(result, "checksums", { value: {sha256:new Uint8Array(32).buffer} });
        if (this.failure === "get-fence") this.revoked = true;
        if (result && ["truncated", "oversize", "body-fence", "corrupt-body"].includes(this.failure)) {
          const data = new Uint8Array(await result.arrayBuffer()), failure = this.failure, self = this;
          const bytes = failure === "truncated" ? data.slice(1) : failure === "oversize" ? new Uint8Array(data.length+1) : failure === "corrupt-body" ? new Uint8Array(data.length).fill(42) : data;
          Object.defineProperty(result, "body", {value:new ReadableStream({pull(controller){if(failure==="body-fence")self.revoked=true;controller.enqueue(bytes);controller.close();}})});
        }
        return this.standard(result);
      }
    }, env.LARGE_QUOTA ? { storageBytes: 1048576, objects: 256, classA: 512, classB: 512 } : { storageBytes: 64, objects: 4, classA: 4, classB: 8 });
    this.assets = this.makeAssets();
  }
  async fetch(request) {
    const raw = await request.json();
    this.failure = raw.failure ?? "";
    this.revoked = false;
    this.clock = raw.now ?? Date.UTC(2026,9,17);
    if (raw.action === "restart") this.assets = this.makeAssets();
    const config = { ownerId: raw.owner ?? "owner", origin: "https://flora.example.test", dbIdentity: "db" }, scope = this.assets.scope(config, () => {
      if(this.revoked)throw Error("AUTHORITY_CHANGED");
    }, () => this.clock);
    try {
      if(raw.action==="hold"){this.holdGets=true;return Response.json({held:true});}
      if(raw.action==="release"){this.holdGets=false;for(const resolve of this.gates.splice(0))resolve();return Response.json({released:true});}
      if (raw.action === "stats" || raw.action === "restart") return Response.json({ ...this.assets.stats(this.clock), calls: this.calls, held:this.gates.length });
      const bytes = new Uint8Array(raw.size ?? 8).fill(raw.value ?? 1), asset = await prepareOTAAsset(raw.appId ?? "app_isso", { key: raw.key ?? "launch", contentType: "application/javascript", fileExtension: ".js" }, bytes, 1);
      if (raw.action === "put") return Response.json({ asset, proof: await scope.put(asset, bytes) });
      const received = await scope.get(asset, raw.proof);
      return Response.json({ bytes: Array.from(received) });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "ERROR" }, { status: 503 });
    }
  }
}
var stdin_default = { fetch(request, env) {
  return env.TEST.getByName("test").fetch(request);
} };
export {
  TestR2,
  stdin_default as default
};
