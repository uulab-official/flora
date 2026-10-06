export function requireLockfile(directory: string): void;
export function snapshotFiles(
  root: string,
  paths: readonly string[],
): Map<string, string>;
export function assertUnchanged(
  root: string,
  snapshot: ReadonlyMap<string, string>,
): void;
