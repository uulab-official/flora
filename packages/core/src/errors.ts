export type ErrorCode =
  | "INVALID_INPUT"
  | "INVALID_RELATION"
  | "TENANT_MISMATCH"
  | "CONFIG_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "CONFLICT"
  | "NOT_FOUND"
  | "LEASE_STALE"
  | "INVALID_TRANSITION"
  | "PERMISSION_DENIED"
  | "PROVIDER_UNCONFIGURED"
  | "PROVIDER_UNSUPPORTED"
  | "PRIVATE_STORE_UNSAFE"
  | "STORE_IN_USE"
  | "INPUT_TOO_LARGE"
  | "MIGRATION_MISMATCH";
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly safeMessage: string;
  constructor(code: ErrorCode) {
    super(code);
    this.name = "DomainError";
    this.code = code;
    this.safeMessage = code;
  }
}
export function ensure(
  condition: unknown,
  code: ErrorCode = "INVALID_INPUT",
): asserts condition {
  if (!condition) throw new DomainError(code);
}
export const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export function safeJson(value: unknown, depth = 0): void {
  ensure(depth <= 64);
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    ensure(Number.isFinite(value));
    return;
  }
  ensure(typeof value === "object" && value !== null);
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    ensure(proto === Array.prototype);
    ensure(Reflect.ownKeys(value).length === value.length + 1);
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      ensure(d && "value" in d && d.enumerable);
      safeJson(d.value, depth + 1);
    }
    return;
  }
  ensure(proto === Object.prototype || proto === null);
  for (const key of Reflect.ownKeys(value)) {
    ensure(typeof key === "string" && !forbidden.has(key));
    const d = Object.getOwnPropertyDescriptor(value, key);
    ensure(d && "value" in d && d.enumerable);
    safeJson(d.value, depth + 1);
  }
}
export function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  safeJson(value);
  ensure(value !== null && typeof value === "object" && !Array.isArray(value));
  const o = value as Record<string, unknown>;
  ensure(
    Object.keys(o).length === keys.length &&
      keys.every((k) => Object.hasOwn(o, k)),
  );
  return o;
}
export function text(value: unknown, max = 4096): string {
  ensure(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= max &&
      !value.includes("\0"),
  );
  return value;
}
export function id(value: unknown): string {
  const s = text(value, 96);
  ensure(/^[a-z][a-z0-9_-]{2,95}$/.test(s) && !forbidden.has(s));
  return s;
}
export function digest(value: unknown): string {
  const s = text(value, 64);
  ensure(/^[a-f0-9]{64}$/.test(s));
  return s;
}
export function list(value: unknown): unknown[] {
  safeJson(value);
  ensure(Array.isArray(value));
  return value;
}
export function integer(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  ensure(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= min &&
      value <= max,
  );
  return value;
}
