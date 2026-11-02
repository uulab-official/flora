import { NativeRequestDeadline, discardNativeBody, readNativeJson } from "./native-request.js";

export type NativePlatform = "ios" | "android";
export interface NativeLease {jobId:string;appId:string;platform:NativePlatform;runnerId:string;attemptId:string;credentialEpoch:number;fence:number;expiresAt:number}
export interface NativeJob {id:string;appId:string;platform:NativePlatform;commitSha:string;appIdentifier:string;teamId?:string;credentials:{kind:string;version:number}[];source:{owner:string;repository:string;ref:string;rootDirectory:string};state:string;configDigest:string}
export interface NativeArtifact {fileName:string;sha256:string;byteLength:number;appIdentifier:string;platform:NativePlatform;signerFingerprint:string;teamId?:string}
export interface NativeGrant {jobId:string;appId:string;platform:NativePlatform;commitSha:string;expiresAt:number;credentials:{kind:string;version:number;payload:{fileBase64:string;password?:string;keyAlias?:string;keyPassword?:string};metadata:Record<string,unknown>;fingerprint:string}[]}
export interface NativeClient {pending(signal?:AbortSignal):Promise<string|null>;claim(jobId:string,signal?:AbortSignal):Promise<{job:NativeJob;lease:NativeLease}>;heartbeat(lease:NativeLease,signal?:AbortSignal):Promise<NativeLease>;credentials(lease:NativeLease,signal?:AbortSignal):Promise<NativeGrant>;complete(lease:NativeLease,artifact:NativeArtifact,signal?:AbortSignal):Promise<NativeJob>;fail(lease:NativeLease,code:string,signal?:AbortSignal):Promise<void>;presence(signal?:AbortSignal):Promise<void>}
export class NativeHttpFailure extends Error {constructor(readonly status:number,readonly safeCode:"BUSY"|"NATIVE_REQUEST_REJECTED"="NATIVE_REQUEST_REJECTED"){super(safeCode);}}
export function nativeAssert(condition:unknown,code="NATIVE_RESPONSE_INVALID"):asserts condition {if(!condition)throw new Error(code);}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.exec(value)?.[0] === value;
}
const ID = /^[a-z][a-z0-9_-]{2,95}$/;
const JOB_ID = /^native_job_[a-z0-9_-]{1,80}$/;

function lease(input: unknown): NativeLease {
  nativeAssert(object(input));
  const fields = ["jobId", "appId", "platform", "runnerId", "attemptId", "credentialEpoch", "fence", "expiresAt"] as const;
  // Own data properties only; no toJSON/accessor is allowed to rewrite authority.
  const descriptors = Object.getOwnPropertyDescriptors(input);
  nativeAssert(fields.every(key => descriptors[key] && "value" in descriptors[key]!));
  const copy = Object.fromEntries(fields.map(key => [key, descriptors[key]!.value])) as unknown as NativeLease;
  nativeAssert([copy.jobId, copy.appId, copy.runnerId, copy.attemptId].every(id => matches(id, ID)) &&
    (copy.platform === "ios" || copy.platform === "android") &&
    [copy.credentialEpoch, copy.fence, copy.expiresAt].every(n => Number.isSafeInteger(n) && n > 0));
  return copy;
}

export function createNativeClient(options: { origin: string; token: string; appId: string; platform: NativePlatform; fetch?: typeof fetch }): NativeClient {
  // Capture the credential and origin once; never read mutable options after I/O.
  const { origin, token, appId, platform, fetch: transport = fetch } = options;
  let url: URL;
  try { url = new URL(origin); } catch { throw new Error("INVALID_NATIVE_CONFIG"); }
  nativeAssert(url.origin === origin && (url.protocol === "https:" || url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) && !url.username && !url.password &&
    matches(token, /^native_runner_[a-z0-9_-]+\.[A-Za-z0-9_-]{43}$/) && matches(appId, ID) &&
    (platform === "ios" || platform === "android") && typeof transport === "function", "INVALID_NATIVE_CONFIG");
  const runnerId = token.split(".")[0]!;
  const bound = (input: unknown): NativeLease => {
    const value = lease(input);
    nativeAssert(value.appId === appId && value.platform === platform && value.runnerId === runnerId);
    nativeAssert(value.expiresAt > Date.now(), "NATIVE_LEASE_EXPIRED");
    return value;
  };

  async function call(action: string, body: unknown, active?: NativeLease, signal?: AbortSignal): Promise<unknown> {
    const deadline = new NativeRequestDeadline(active?.expiresAt, signal);
    try {
      deadline.assertLive();
      let response: Response;
      try {
        response = await deadline.wait(() => transport(origin + "/api/native-runner/" + action, {
          method: "POST", redirect: "error",
          headers: { Authorization: "Bearer " + token, Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify(body), signal: deadline.signal,
        }), discardNativeBody);
      } catch { throw new Error(deadline.failure() ?? "NATIVE_TRANSPORT_UNAVAILABLE"); }
      // Once a status is observed, a broken/error body cannot soften it into a
      // transient network failure. Only exact bounded 409/BUSY receives that code.
      if (!response.ok) {
        let busy = false;
        if (response.status === 409) {
          try {
            const problem = await readNativeJson(response, deadline, 16 * 1024);
            busy = object(problem) && problem.error === "BUSY" && Object.keys(problem).length === 1;
          } catch { /* preserve the authoritative HTTP status */ }
        } else discardNativeBody(response);
        throw new NativeHttpFailure(response.status, busy ? "BUSY" : "NATIVE_REQUEST_REJECTED");
      }
      let value: unknown;
      try { value = await readNativeJson(response, deadline); }
      catch (error) {
        const code = deadline.failure();
        if (code) throw new Error(code);
        if (error instanceof Error && error.message === "NATIVE_RESPONSE_INVALID") throw new Error("NATIVE_RESPONSE_INVALID");
        throw new Error("NATIVE_TRANSPORT_UNAVAILABLE");
      }
      deadline.assertLive();
      return value;
    } finally { deadline.close(); }
  }

  return {
    async pending(signal) {
      const raw = await call("pending", {}, undefined, signal);
      nativeAssert(object(raw) && Object.keys(raw).length === 1 && Object.hasOwn(raw, "jobId") &&
        (raw.jobId === null || matches(raw.jobId, JOB_ID)));
      return raw.jobId as string | null;
    },
    async claim(jobId, signal) {
      nativeAssert(matches(jobId, JOB_ID));
      const raw = await call("claim", { jobId }, undefined, signal);
      nativeAssert(object(raw));
      const l = bound(raw.lease), j = raw.job as NativeJob;
      nativeAssert(object(j) && j.id === jobId && j.id === l.jobId && j.appId === l.appId && j.platform === l.platform &&
        j.state === "leased" && matches(j.commitSha, /^[a-f0-9]{40}$/) && Array.isArray(j.credentials) &&
        object(j.source) && typeof j.source.owner === "string" && typeof j.source.repository === "string");
      return { job: j, lease: l };
    },
    async heartbeat(input, signal) {
      const original = bound(input), next = bound(await call("heartbeat", { lease: original }, original, signal));
      nativeAssert((["jobId", "appId", "platform", "runnerId", "attemptId", "credentialEpoch", "fence"] as const)
        .every(key => next[key] === original[key]));
      return next;
    },
    async credentials(input, signal) {
      const l = bound(input), g = await call("credentials", { lease: l }, l, signal) as NativeGrant;
      nativeAssert(object(g) && g.jobId === l.jobId && g.appId === l.appId && g.platform === l.platform &&
        Number.isSafeInteger(g.expiresAt) && g.expiresAt > Date.now() && g.expiresAt <= Date.now() + 125000 &&
        matches(g.commitSha, /^[a-f0-9]{40}$/) && Array.isArray(g.credentials));
      return g;
    },
    async complete(input, artifact, signal) {
      const l = bound(input), j = await call("complete", { lease: l, artifact }, l, signal) as NativeJob;
      nativeAssert(object(j) && j.id === l.jobId && j.appId === l.appId && j.platform === l.platform && j.state === "succeeded");
      return j;
    },
    async fail(input, code, signal) { const l = bound(input); await call("fail", { lease: l, code }, l, signal); },
    async presence(signal) {
      const v = await call("presence", {}, undefined, signal) as { runnerId: string; lastSeenAt: number };
      nativeAssert(object(v) && v.runnerId === runnerId && Number.isSafeInteger(v.lastSeenAt));
    },
  };
}
