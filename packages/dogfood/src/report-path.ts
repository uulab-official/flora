import { ensure, text } from "@app-ops/core";
import type { BaselineBundleV1 } from "./types.js";
type Platform = BaselineBundleV1["platform"];
interface LexicalPath { root: string | null; segments: string[] }

// Deliberately strict evidence metadata, not a filesystem path resolver.
function parsePath(value: string, platform: Platform, trailing: boolean): LexicalPath {
  text(value);
  ensure(platform === "linux" || platform === "darwin" || platform === "win32");
  ensure(!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
  let path = value;
  let root: string | null = null;
  if (platform === "win32") {
    path = path.replaceAll("\\", "/");
    ensure(!path.startsWith("//?/") && !path.startsWith("//./"));
    if (/^[A-Za-z]:\//.test(path)) {
      root = path.slice(0, 2); path = path.slice(3);
    } else if (path.startsWith("//")) {
      const match = /^\/\/([^/:]+)\/([^/:]+)(?:\/|$)/.exec(path);
      ensure(match && ![".", ".."].includes(match[1]!) && ![".", ".."].includes(match[2]!));
      root = "//" + match[1] + "/" + match[2]; path = path.slice(match[0].length);
    } else ensure(!path.startsWith("/"));
  } else {
    ensure(!path.includes("\\"));
    if (path.startsWith("/")) { root = "/"; path = path.slice(1); }
  }
  ensure(!path.includes(":"));
  // A separator already consumed as part of the root cannot be repeated.
  ensure(path !== "/");
  if (trailing && path.endsWith("/")) path = path.slice(0, -1);
  const segments = path === "" && root !== null ? [] : path.split("/");
  ensure(segments.every(segment => segment !== "" && segment !== "." && segment !== ".."));
  return { root, segments };
}

export function validateReportMetadata(platform: Platform, sourceRoot: string, reportPath: string): void {
  ensure(parsePath(sourceRoot, platform, true).root !== null);
  const report = parsePath(reportPath, platform, false);
  ensure(report.segments.length > 0);
  // Relative metadata must use canonical forward slashes, including on Windows.
  if (report.root === null) ensure(reportPath === report.segments.join("/"));
}

export function normalizeReportTestPath(input: {
  platform: Platform; sourceRoot: string; name: string; expectedFiles: readonly string[];
}): string {
  const root = parsePath(input.sourceRoot, input.platform, true);
  ensure(root.root !== null);
  const name = parsePath(input.name, input.platform, false);
  let relative: string;
  if (name.root === null) relative = input.name;
  else {
    ensure(name.root === root.root && name.segments.length > root.segments.length);
    ensure(root.segments.every((part, index) => name.segments[index] === part));
    relative = name.segments.slice(root.segments.length).join("/");
  }
  ensure(input.expectedFiles.includes(relative));
  return relative;
}
