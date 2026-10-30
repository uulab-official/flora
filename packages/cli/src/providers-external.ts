/** Verified provider REST endpoints; all operations are opt-in and user-owned.
 * No provider token, HTTP response, or arbitrary provider URL is logged.
 * This local CLI adapter is NOT an authenticated Flora-hosted integration. */
export type RemoteBuildProvider = "codemagic" | "bitrise";
export type RemoteBuildOperation = "start" | "status" | "cancel";
export interface RemoteBuildPlan {
  provider: RemoteBuildProvider;
  operation: RemoteBuildOperation;
  endpoint: string;
  method: "GET" | "POST";
  payload?: Record<string, unknown>;
  appId?: string;
  buildId?: string;
  branch?: string;
  workflow?: string;
  execute: boolean;
}
export interface RemoteBuildResult {
  provider: RemoteBuildProvider;
  operation: RemoteBuildOperation;
  state: "requested" | "status" | "cancel_requested" | "already_finished";
  buildId: string;
  status?: string;
}
export class RemoteProviderError extends Error {
  constructor(readonly code: string) { super(code); this.name = "RemoteProviderError"; }
}
const bad = (code = "PROVIDER_INVALID_INPUT"): never => { throw new RemoteProviderError(code); };
const tokenEnvironment = { codemagic: "CODEMAGIC_API_TOKEN", bitrise: "BITRISE_API_TOKEN" } as const;
const labels = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const safeBranch = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/;
function identifier(value: string | undefined): string {
  if (typeof value !== "string" || !labels.test(value)) bad();
  return value;
}
function branchName(value: string | undefined): string {
  if (typeof value !== "string" || !safeBranch.test(value) || value.includes("..") ||
      value.includes("//") || value.endsWith("/") || value.endsWith(".lock")) bad();
  return value;
}
/** No command strings, arbitrary URLs, environment overrides, or secret values. */
export function parseRemoteBuildPlan(args: readonly string[]): RemoteBuildPlan {
  const [provider, operation, ...rest] = args;
  if (provider !== "codemagic" && provider !== "bitrise") bad();
  if (operation !== "start" && operation !== "status" && operation !== "cancel") bad();
  if (provider === "codemagic" && operation === "status") bad("PROVIDER_UNSUPPORTED");
  const flags = new Map<string, string>();
  let execute = false;
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i]!;
    if (name === "--execute") {
      if (execute) bad();
      execute = true;
    } else if (["--app", "--workflow", "--branch", "--build"].includes(name)) {
      if (flags.has(name)) bad();
      const value = rest[++i];
      if (!value || value.startsWith("--") || value.length > 128) bad();
      flags.set(name, value);
    } else bad();
  }
  const app = flags.get("--app"), workflow = flags.get("--workflow");
  const selectedBranch = flags.get("--branch"), build = flags.get("--build");
  if (operation === "start") {
    if (flags.size !== 3 || build) bad();
    const appId = identifier(app), workflowId = identifier(workflow), branch = branchName(selectedBranch);
    const endpoint = provider === "codemagic" ?
      "https://api.codemagic.io/builds" : "https://api.bitrise.io/v0.1/apps/" + encodeURIComponent(appId) + "/builds";
    const payload = provider === "codemagic" ?
      { appId, workflowId, branch } : { hook_info: { type: "bitrise" }, build_params: { branch, workflow_id: workflowId } };
    return { provider, operation, endpoint, method: "POST", payload, appId, workflow: workflowId, branch, execute };
  }
  if (provider === "codemagic") {
    if (operation !== "cancel" || flags.size !== 1 || !build) bad();
    const buildId = identifier(build);
    return { provider, operation, endpoint: "https://api.codemagic.io/builds/" + encodeURIComponent(buildId) + "/cancel", method: "POST", buildId, execute };
  }
  if (flags.size !== 2 || !app || !build) bad();
  const appId = identifier(app), buildId = identifier(build);
  return {
    provider, operation, appId, buildId, execute,
    endpoint: "https://api.bitrise.io/v0.1/apps/" + encodeURIComponent(appId) + "/builds/" + encodeURIComponent(buildId) + (operation === "cancel" ? "/abort" : ""),
    method: operation === "status" ? "GET" : "POST",
    ...(operation === "cancel" ? { payload: {} } : {}),
  };
}
async function readBoundedResponse(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d{1,8}$/.test(length) || Number(length) > 65536)) bad("PROVIDER_RESPONSE_INVALID");
  if (!response.body) return null;
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) bad("PROVIDER_RESPONSE_INVALID");
      chunks.push(part.value);
    }
  } finally { void reader.cancel().catch(() => {}); }
  if (!size) return null;
  const bytes = new Uint8Array(size); let index = 0;
  for (const chunk of chunks) { bytes.set(chunk, index); index += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { return bad("PROVIDER_RESPONSE_INVALID"); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("PROVIDER_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}
function responseId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(value)) bad("PROVIDER_RESPONSE_INVALID");
  return value;
}
function mapFailure(status: number): never {
  if (status === 401 || status === 403) bad("PROVIDER_PERMISSION_DENIED");
  if (status === 429) bad("PROVIDER_RATE_LIMITED");
  if (status === 408 || status === 504) bad("PROVIDER_TIMEOUT");
  if (status >= 300 && status < 400) bad("PROVIDER_REDIRECT_REJECTED");
  return bad("PROVIDER_UNAVAILABLE");
}
/** Only starts/cancels when caller explicitly passes --execute and owns token. */
export async function runRemoteBuild(
  plan: RemoteBuildPlan, env: Readonly<Record<string, string | undefined>>,
  request: typeof fetch = fetch,
): Promise<RemoteBuildResult | { dryRun: true; plan: Omit<RemoteBuildPlan, "payload">; tokenEnvironment: string; }> {
  const { payload, ...publicPlan } = plan;
  if (!plan.execute) return { dryRun: true, plan: publicPlan, tokenEnvironment: tokenEnvironment[plan.provider] };
  const token = env[tokenEnvironment[plan.provider]];
  if (typeof token !== "string" || token.length < 8 || token.length > 8192 || /[\r\n\0]/.test(token))
    bad("PROVIDER_TOKEN_MISSING");
  const origin = plan.provider === "codemagic" ? "https://api.codemagic.io" : "https://api.bitrise.io";
  const parsed = new URL(plan.endpoint);
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.search || parsed.hash ||
    !["GET", "POST"].includes(plan.method)) bad();
  let response: Response;
  try {
    response = await request(plan.endpoint, {
      method: plan.method, redirect: "manual", signal: AbortSignal.timeout(12000),
      headers: { "Accept": "application/json", ...(plan.provider === "codemagic" ? { "x-auth-token": token } : { "Authorization": token }),
        ...(plan.method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(plan.method === "POST" ? { body: JSON.stringify(payload ?? {}) } : {}),
    });
  } catch { return bad("PROVIDER_NETWORK_UNAVAILABLE"); }
  if (plan.provider === "codemagic" && plan.operation === "cancel" && response.status === 208) {
    return { provider: plan.provider, operation: plan.operation, state: "already_finished", buildId: plan.buildId! };
  }
  if (response.status < 200 || response.status >= 300) mapFailure(response.status);
  const body = await readBoundedResponse(response);
  if (plan.operation === "cancel") return { provider: plan.provider, operation: "cancel", state: "cancel_requested", buildId: plan.buildId! };
  const data = record(body);
  if (plan.operation === "status") {
    const detail = record(data.data);
    const n = detail.status;
    if (typeof n !== "number" || ![0, 1, 2, 3, 4].includes(n)) bad("PROVIDER_RESPONSE_INVALID");
    const status = ["running", "succeeded", "failed", "aborted_failed", "aborted_success"][n]!;
    return { provider: plan.provider, operation: plan.operation, state: "status", buildId: plan.buildId!, status };
  }
  let buildId: string;
  if (plan.provider === "codemagic") buildId = responseId(data.buildId);
  else {
    const first = Array.isArray(data.results) ? data.results[0] as unknown : null;
    const fromResults = first && typeof first === "object" && !Array.isArray(first) ? (first as Record<string, unknown>).build_slug : null;
    buildId = responseId(data.build_slug ?? fromResults);
  }
  return { provider: plan.provider, operation: "start", state: "requested", buildId };
}
