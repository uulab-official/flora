#!/usr/bin/env node
import { readNativeConfig, runNativeDaemon, runNativeJob, assertNativeReconciled } from "./native-controller.js";
import { NATIVE_USAGE, nativeCommandFailure, runNativeCommand } from "./native-command.js";

const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const result = await runNativeCommand(process.argv.slice(2), {
    readConfig: readNativeConfig, checkRecovery: assertNativeReconciled, runDaemon: runNativeDaemon, runJob: runNativeJob,
  }, controller.signal);
  process.stdout.write(result.state === "help" ? NATIVE_USAGE : JSON.stringify(result) + "\n");
} catch (error) {
  const { exitCode, ...result } = nativeCommandFailure(error, controller.signal);
  (exitCode === 0 ? process.stdout : process.stderr).write(JSON.stringify(result) + "\n");
  process.exitCode = exitCode;
} finally {
  controller.abort();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
