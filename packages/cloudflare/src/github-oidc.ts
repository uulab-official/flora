import { AuthFailure } from "./auth-state.js";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_OIDC_JWKS = GITHUB_OIDC_ISSUER + "/.well-known/jwks";
export interface GitHubCITrust {
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string;
  ref: string;
  jobWorkflowRef: string;
  jobWorkflowSha: string;
}
export interface GitHubCIIdentity { commitSha: string; runId: string; runAttempt: string; expiresAt: number }
function denied(): never { throw new AuthFailure(403, "CI_IDENTITY_REJECTED"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return denied();
  return value as Record<string, unknown>;
}
function bytes(value: string, max: number): Uint8Array<ArrayBuffer> {
  if (!value || value.length > max * 2 || !/^[A-Za-z0-9_-]+$/.test(value)) return denied();
  try {
    const decoded = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
    if (decoded.length > max || btoa(String.fromCharCode(...decoded)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") !== value) return denied();
    return decoded;
  } catch { return denied(); }
}
function jsonSegment(value: string, max: number) {
  try { return record(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes(value, max)))); }
  catch { return denied(); }
}
function number(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return denied(); return value; }

/** Fixed GitHub issuer/JWKS, no discovery or token-supplied key URLs. No JWT or
 * response body is included in errors/logs. Verification is request-scoped. */
export async function verifyGitHubCIJWT(token: string, trust: GitHubCITrust, audience: string, now: number, request: typeof fetch = fetch): Promise<GitHubCIIdentity> {
  if (typeof token !== "string" || token.length > 16_384) return denied();
  const parts = token.split("."); if (parts.length !== 3) return denied();
  const header = jsonSegment(parts[0]!, 1024), claims = jsonSegment(parts[1]!, 10_240), signature = bytes(parts[2]!, 512);
  if (header.alg !== "RS256" || header.typ !== "JWT" || typeof header.kid !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(header.kid)
    || Object.keys(header).some(key => !["alg", "typ", "kid", "x5t"].includes(key))) return denied();
  const sec = Math.floor(now / 1000), exp = number(claims.exp), iat = number(claims.iat), nbf = number(claims.nbf);
  if (claims.iss !== GITHUB_OIDC_ISSUER || claims.aud !== audience || exp <= sec || exp > sec + 600 || iat > sec + 30 || iat < sec - 600
    || nbf > sec + 30 || nbf > exp || exp <= iat || exp - iat > 600) return denied();
  const [owner, repository] = trust.repository.split("/");
  const subjects = ["repo:" + trust.repository + ":ref:" + trust.ref,
    `repo:${owner}@${trust.repositoryOwnerId}/${repository}@${trust.repositoryId}:ref:${trust.ref}`];
  if (typeof claims.sub !== "string" || !subjects.includes(claims.sub) || claims.repository !== trust.repository || claims.repository_id !== trust.repositoryId
    || claims.repository_owner !== owner || claims.repository_owner_id !== trust.repositoryOwnerId || claims.ref !== trust.ref || claims.ref_type !== "branch"
    || claims.event_name !== "push" || claims.runner_environment !== "github-hosted" || claims.job_workflow_ref !== trust.jobWorkflowRef
    || claims.job_workflow_sha !== trust.jobWorkflowSha || typeof claims.sha !== "string" || !/^[a-f0-9]{40}$/.test(claims.sha)
    || typeof claims.run_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(claims.run_id) || typeof claims.run_attempt !== "string" || !/^[1-9][0-9]{0,5}$/.test(claims.run_attempt)
    || typeof claims.jti !== "string" || claims.jti.length < 1 || claims.jti.length > 256 || /[\u0000-\u001f\u007f]/.test(claims.jti)) return denied();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await request(GITHUB_OIDC_JWKS, { redirect: "manual", signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "flora-ci-admission" } });
    if (response.status !== 200 || !response.body || response.headers.has("Location")) throw new AuthFailure(503, "CI_IDENTITY_UNAVAILABLE");
    const length = response.headers.get("Content-Length");
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 65_536)) throw new AuthFailure(503, "CI_IDENTITY_UNAVAILABLE");
    reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 65_536) throw new AuthFailure(503, "CI_IDENTITY_UNAVAILABLE"); chunks.push(part.value); }
    const raw = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
    const data = record(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw)));
    if (!Array.isArray(data.keys) || data.keys.length > 32) throw new AuthFailure(503, "CI_IDENTITY_UNAVAILABLE");
    const matches = data.keys.map(record).filter(key => key.kid === header.kid); if (matches.length !== 1) return denied();
    const jwk = matches[0]!;
    if (jwk.kty !== "RSA" || jwk.alg !== "RS256" || jwk.use !== "sig" || jwk.e !== "AQAB" || typeof jwk.n !== "string" || Object.hasOwn(jwk, "d")
      || bytes(jwk.n, 512).length < 256 || signature.length !== bytes(jwk.n, 512).length) return denied();
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: "AQAB", alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(parts[0] + "." + parts[1]))) return denied();
    return { commitSha: claims.sha, runId: claims.run_id, runAttempt: claims.run_attempt, expiresAt: exp * 1000 };
  } catch (error) { throw error instanceof AuthFailure ? error : new AuthFailure(503, "CI_IDENTITY_UNAVAILABLE"); }
  finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); }
}
