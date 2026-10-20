import { Buffer } from "node:buffer";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export interface PasswordVerifierV1 {
  readonly version: 1;
  readonly algorithm: "scrypt";
  readonly N: 32768;
  readonly r: 8;
  readonly p: 3;
  readonly maxmem: 67108864;
  readonly keyLength: 32;
  readonly saltHex: string;
  readonly hashHex: string;
}

const parameters = {
  version: 1,
  algorithm: "scrypt",
  N: 32768,
  r: 8,
  p: 3,
  maxmem: 67108864,
  keyLength: 32,
} as const;

const verifierFields = [...Object.keys(parameters), "saltHex", "hashHex"];

export function validPassword(password: unknown, minimum: 12 | 15 = 15): password is string {
  if (minimum !== 12 && minimum !== 15) return false;
  if (typeof password !== "string" || password.length > 256) return false;
  if (Buffer.byteLength(password, "utf8") > 1024) return false;
  let length = 0;
  for (const character of password) {
    const codepoint = character.codePointAt(0)!;
    // UTF-8 would replace an unpaired UTF-16 surrogate, changing the password.
    if (codepoint >= 0xd800 && codepoint <= 0xdfff) return false;
    if (++length > 128) return false;
  }
  return length >= minimum;
}

function readVerifier(value: unknown): { salt: Buffer; hash: Buffer } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  // Snapshot only own data properties, without invoking getters or consulting
  // attacker-controlled work factors after validation.
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== verifierFields.length) return null;
  for (const field of verifierFields) {
    if (!Object.hasOwn(fields, field) || !("value" in fields[field]!)) return null;
  }
  for (const [field, expected] of Object.entries(parameters)) {
    if (fields[field]!.value !== expected) return null;
  }
  const saltHex: unknown = fields.saltHex!.value;
  const hashHex: unknown = fields.hashHex!.value;
  if (typeof saltHex !== "string" || !/^[0-9a-f]{32}$/.test(saltHex)) return null;
  if (typeof hashHex !== "string" || !/^[0-9a-f]{64}$/.test(hashHex)) return null;
  return { salt: Buffer.from(saltHex, "hex"), hash: Buffer.from(hashHex, "hex") };
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      parameters.keyLength,
      {
        N: parameters.N,
        r: parameters.r,
        p: parameters.p,
        maxmem: parameters.maxmem,
      },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

/** DO-only kernel; the caller must admit at most one expensive KDF at a time. */
export async function createPasswordVerifier(
  password: string,
  minimum: 12 | 15 = 15,
): Promise<PasswordVerifierV1> {
  if (!validPassword(password, minimum)) throw new Error("Invalid password");
  try {
    const salt = randomBytes(16);
    const hash = await deriveKey(password, salt);
    return {
      ...parameters,
      saltHex: Array.from(salt, byte => byte.toString(16).padStart(2, "0")).join(""),
      hashHex: Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join(""),
    };
  } catch {
    throw new Error("Password verifier creation failed");
  }
}

export async function verifyPassword(
  password: string,
  verifier: PasswordVerifierV1,
  minimum: 12 | 15 = 15,
): Promise<boolean> {
  let stored: ReturnType<typeof readVerifier>;
  try {
    if (!validPassword(password, minimum)) return false;
    stored = readVerifier(verifier);
  } catch {
    return false;
  }
  if (!stored) return false;
  try {
    const actual = await deriveKey(password, stored.salt);
    return timingSafeEqual(actual, stored.hash);
  } catch {
    throw new Error("PASSWORD_KDF_FAILED");
  }
}
