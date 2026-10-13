import { spawn } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";
const npmCodes = ["ERESOLVE", "EINTEGRITY", "ENOTCACHED", "ELOCKVERIFY", "EUSAGE", "ENOENT", "EACCES", "ECONNRESET", "ETIMEDOUT", "ENOSPC", "ENOMEM", "EBADENGINE", "EUNSUPPORTEDPROTOCOL", "E401", "E403", "E404", "E500", "ENETUNREACH"];
const safeCodes = new Set(["EXECUTION_FAILED", "CONFIG_CHANGED", "ARTIFACT_INVALID", "SOURCE_UNAVAILABLE", "ISOLATION_UNAVAILABLE", "DEPENDENCY_CACHE_INVALID", "PROCESS_TIMEOUT", "PROCESS_CANCELLED", "PROCESS_OUTPUT_LIMIT", "PROCESS_SPAWN_FAILED", "NPM_CONFIG_DUPLICATE", ...npmCodes.map(code => "NPM_" + code)]);
const childStages = ["configuration", "source-copy", "npm-version", "npm-install", "cache-validate", "cache-copy", "exporter", "artifact-read"];
const safeStages = new Set(["execution", "source-verified", "dependency-seed", "dependency-preparation", "compiler", "artifact-verified", ...childStages, ...childStages.map(stage => "dependency-preparation-" + stage), ...childStages.map(stage => "compiler-" + stage)]);
export function diagnosticLine(stage, code) { return JSON.stringify({ diagnostic: true, stage: safeStages.has(stage) ? stage : "execution", ...(code ? { code: safeCodes.has(code) ? code : "EXECUTION_FAILED" } : {}) }); }
export function npmConfigurationEnvironment(directory = "/runner/config") { return { npm_config_userconfig: join(directory, "npm-user.rc"), npm_config_globalconfig: join(directory, "npm-global.rc") }; }
export class ProcessFailure extends Error {
    safeCode;
    containerDiagnostic;
    constructor(safeCode, containerDiagnostic) {
        super("EXECUTION_FAILED");
        this.safeCode = safeCode;
        this.containerDiagnostic = containerDiagnostic;
    }
}
export function diagnosticCode(error) { if (error instanceof ProcessFailure)
    return error.safeCode; const code = error instanceof Error ? error.message : "EXECUTION_FAILED"; return safeCodes.has(code) ? code : "EXECUTION_FAILED"; }
function childDiagnostic(stderr) {
    let found;
    for (const line of stderr.split(/\r?\n/)) {
        if (!line.startsWith("FLORA_DIAGNOSTIC ") || line.length > 512)
            continue;
        try {
            const raw = JSON.parse(line.slice(17));
            if (raw.diagnostic === true && typeof raw.stage === "string" && childStages.includes(raw.stage) && typeof raw.code === "string" && safeCodes.has(raw.code) && Object.keys(raw).length === 3)
                found = { diagnostic: true, stage: raw.stage, code: raw.code };
        }
        catch { }
    }
    return found;
}
function failure(reason, stderr, diagnostics) {
    const code = reason === "timeout" ? "PROCESS_TIMEOUT" : reason === "cancelled" ? "PROCESS_CANCELLED" : reason === "output" ? "PROCESS_OUTPUT_LIMIT" : reason === "spawn" ? "PROCESS_SPAWN_FAILED" : "EXECUTION_FAILED";
    if (diagnostics === "npm" && reason === "exit") {
        if (/double-loading config [^\n]{1,256} as [^\n]{1,128} previously loaded as/.test(stderr))
            return new ProcessFailure("NPM_CONFIG_DUPLICATE");
        const match = /npm (?:error|ERR!) code ([A-Z][A-Z0-9_]{0,63})(?:\r?\n|$)/.exec(stderr);
        if (match && npmCodes.includes(match[1]))
            return new ProcessFailure("NPM_" + match[1]);
    }
    return new ProcessFailure(code, diagnostics === "container" ? childDiagnostic(stderr) : undefined);
}
export function processEnvironment(extra = {}) {
    const path = (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(delimiter).filter(isAbsolute).join(delimiter);
    return { PATH: path, LANG: "C.UTF-8", CI: "1", ...extra };
}
export async function trustedProcess(executable, args, options = {}) {
    let reason = "exit";
    const controller = new AbortController(), timeout = setTimeout(() => { reason = "timeout"; controller.abort(); }, options.timeoutMs ?? 60_000);
    const cancel = () => { reason = "cancelled"; controller.abort(); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted)
        cancel();
    let child;
    try {
        return await new Promise((resolve, reject) => {
            let size = 0, failed = false, finished = false, stderr = "";
            const parts = [];
            const kill = () => { if (child?.pid) {
                try {
                    if (process.platform !== "win32")
                        process.kill(-child.pid, "SIGKILL");
                    else
                        child.kill("SIGKILL");
                }
                catch { }
            } };
            // Drain the child close event before returning to a caller that removes its
            // source directory or verifies Docker cleanup. SIGKILL alone is not an exit.
            const fail = () => { if (!finished && !failed) {
                failed = true;
                kill();
            } };
            child = spawn(executable, [...args], { ...(options.cwd ? { cwd: options.cwd } : {}), env: options.env ?? processEnvironment(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
            controller.signal.addEventListener("abort", fail, { once: true });
            const append = (part, stdout) => { if (failed)
                return; size += part.length; if (size > (options.maxBytes ?? 1024 * 1024)) {
                reason = "output";
                fail();
                return;
            } if (stdout)
                parts.push(part);
            else if (options.diagnostics)
                stderr = (stderr + part.toString("utf8")).slice(-16384); };
            child.stdout.on("data", part => append(part, true));
            child.stderr.on("data", part => append(part, false));
            child.on("error", () => { reason = "spawn"; fail(); });
            child.on("close", code => { controller.signal.removeEventListener("abort", fail); if (!finished) {
                finished = true;
                if (code === 0 && !failed && !controller.signal.aborted)
                    resolve(Buffer.concat(parts).toString("utf8"));
                else
                    reject(failure(reason, stderr, options.diagnostics));
            } });
            child.stdin.on("error", () => { });
            child.stdin.end(options.input ?? "");
            if (controller.signal.aborted)
                fail();
        });
    }
    finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", cancel);
    }
}
