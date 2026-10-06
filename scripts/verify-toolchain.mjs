import { resolvePnpmEntry } from "./pnpm-entry.mjs";
if (process.versions.node !== "24.19.0" || !resolvePnpmEntry()) {
  console.error(
    "Use Node 24.19.0 and run through pnpm 11.19.0. No machine settings were changed.",
  );
  process.exitCode = 1;
} else console.log("Toolchain verified: Node 24.19.0 / pnpm 11.19.0");
