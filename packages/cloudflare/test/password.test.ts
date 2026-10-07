import assert from "node:assert/strict";
import crypto, { randomBytes, scryptSync } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { inspect } from "node:util";
import {
  createPasswordVerifier,
  verifyPassword,
  type PasswordVerifierV1,
} from "../src/auth/password.ts";

function syntheticPassword(length = 32): string {
  return randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
}

test("creates the exact versioned scrypt verifier with an independent reference", async () => {
  const password = syntheticPassword();
  const verifier = await createPasswordVerifier(password);
  assert.deepEqual(Object.keys(verifier).sort(), [
    "N",
    "algorithm",
    "hashHex",
    "keyLength",
    "maxmem",
    "p",
    "r",
    "saltHex",
    "version",
  ]);
  assert.deepEqual(
    { ...verifier, saltHex: undefined, hashHex: undefined },
    {
      version: 1,
      algorithm: "scrypt",
      N: 32768,
      r: 8,
      p: 3,
      maxmem: 67108864,
      keyLength: 32,
      saltHex: undefined,
      hashHex: undefined,
    },
  );
  assert.match(verifier.saltHex, /^[0-9a-f]{32}$/);
  assert.match(verifier.hashHex, /^[0-9a-f]{64}$/);
  const reference = scryptSync(password, Buffer.from(verifier.saltHex, "hex"), 32, {
    N: 32768,
    r: 8,
    p: 3,
    maxmem: 67108864,
  });
  assert.equal(verifier.hashHex, reference.toString("hex"));
});

test("uses independent random salts for repeated creation", async () => {
  const password = syntheticPassword();
  const first = await createPasswordVerifier(password);
  const second = await createPasswordVerifier(password);
  assert.notEqual(first.saltHex, second.saltHex);
  assert.notEqual(first.hashHex, second.hashHex);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password, second), true);
});

test("verifies the exact password and rejects a different password", async () => {
  const password = syntheticPassword();
  const verifier = await createPasswordVerifier(password);
  assert.equal(await verifyPassword(password, verifier), true);
  assert.equal(
    await verifyPassword(password + syntheticPassword(1), verifier),
    false,
  );
});

test("preserves leading and trailing whitespace", async () => {
  const password = ` \t${syntheticPassword()}\n `;
  const verifier = await createPasswordVerifier(password);
  assert.equal(await verifyPassword(password, verifier), true);
  assert.equal(await verifyPassword(password.trim(), verifier), false);
});

test("does not normalize canonically equivalent Unicode", async () => {
  const password = `${syntheticPassword()}\u00e9`;
  const verifier = await createPasswordVerifier(password);
  assert.equal(await verifyPassword(password, verifier), true);
  assert.equal(await verifyPassword(password.normalize("NFD"), verifier), false);
});

test("accepts the 15 and 128 Unicode-codepoint boundaries without truncation", async () => {
  for (const length of [15, 128]) {
    const password = String.fromCodePoint(0x1f300 + randomBytes(1)[0]!).repeat(
      length,
    );
    assert.equal([...password].length, length);
    const verifier = await createPasswordVerifier(password);
    assert.equal(await verifyPassword(password, verifier), true);
    if (length === 128) {
      assert.equal(
        await verifyPassword(password + syntheticPassword(1), verifier),
        false,
      );
    }
  }
});

test("invalid password input fails uniformly without exposing its value", async () => {
  const marker = syntheticPassword();
  const invalid: unknown[] = [
    undefined,
    null,
    42,
    [],
    {
      toString() {
        throw new Error(marker);
      },
    },
    syntheticPassword(14),
    syntheticPassword(129),
    syntheticPassword(1025),
    String.fromCodePoint(0x1f680).repeat(14),
    String.fromCodePoint(0x1f680).repeat(129),
    marker + "\ud800",
    marker + "\udfff",
    "\ud800" + marker,
  ];
  for (const password of invalid) {
    await assert.rejects(
      createPasswordVerifier(password as string),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Invalid password");
        assert.equal(error.message.includes(marker), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});

test("rejects malformed inputs and verifier fields before invoking scrypt", async (t) => {
  const password = syntheticPassword();
  const verifier = await createPasswordVerifier(password);
  const invalid: unknown[] = [undefined, null, 1, [], password, {}];
  for (const [field, values] of Object.entries({
    version: [0, 2, "1"],
    algorithm: ["pbkdf2", "SCRYPT", null],
    N: [16384, 65536, 2 ** 30, "32768"],
    r: [4, 16, "8"],
    p: [1, 4, "3"],
    maxmem: [33554432, 134217728, Infinity, "67108864"],
    keyLength: [16, 64, "32"],
    saltHex: [
      null, 1, "", "0".repeat(31), "0".repeat(33),
      "A".repeat(32), "g".repeat(32), verifier.saltHex + "\n",
    ],
    hashHex: [
      null, 1, "", "0".repeat(63), "0".repeat(65),
      "A".repeat(64), "g".repeat(64), verifier.hashHex + "\n",
    ],
  })) {
    for (const value of values) invalid.push({ ...verifier, [field]: value });
  }
  for (const field of Object.keys(verifier)) {
    const missing: Record<string, unknown> = { ...verifier };
    delete missing[field];
    invalid.push(missing);
  }
  invalid.push({ ...verifier, cost: 1 });
  invalid.push({ ...verifier, [Symbol()]: 1 });
  invalid.push(Object.create(verifier));
  invalid.push(new Proxy({}, {
    ownKeys() {
      throw new Error(password);
    },
  }));
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  invalid.push(revoked.proxy);
  let getterReads = 0;
  invalid.push({
    ...verifier,
    get N() {
      getterReads++;
      return 32768;
    },
  });
  let calls = 0;
  t.mock.method(crypto, "scrypt", () => {
    calls++;
    throw new Error(password);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (const candidate of invalid) {
    assert.equal(
      await verifyPassword(password, candidate as PasswordVerifierV1),
      false,
    );
  }
  for (const candidate of [
    null, 42, syntheticPassword(14), syntheticPassword(129), password + "\ud800",
  ]) {
    assert.equal(await verifyPassword(candidate as string, verifier), false);
  }
  assert.equal(getterReads, 0);
  assert.equal(calls, 0);
});

async function assertSanitizedFailure(
  result: Promise<unknown>,
  expectedMessage: string,
  sensitiveValues: readonly string[],
): Promise<void> {
  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, expectedMessage);
    assert.equal(error.cause, undefined);
    const rendered = inspect(error, { showHidden: true });
    for (const value of sensitiveValues) {
      assert.equal(rendered.includes(value), false);
    }
    return true;
  });
}

for (const mode of ["synchronous throw", "asynchronous callback error"] as const) {
  test(`${mode} rejects with fixed nonsecret errors`, async (t) => {
    const password = syntheticPassword();
    const verifier = await createPasswordVerifier(password);
    const nativeDetail = syntheticPassword();
    const sensitiveValues = [
      password, verifier.saltHex, verifier.hashHex, nativeDetail,
    ];
    const nativeError = new Error(sensitiveValues.join(":"));
    t.mock.method(crypto, "scrypt", (...args: unknown[]) => {
      if (mode === "synchronous throw") throw nativeError;
      const callback = args.at(-1) as (error: Error, key: Buffer) => void;
      queueMicrotask(() => callback(nativeError, Buffer.alloc(0)));
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    await assertSanitizedFailure(
      verifyPassword(password, verifier),
      "PASSWORD_KDF_FAILED",
      sensitiveValues,
    );
    await assertSanitizedFailure(
      createPasswordVerifier(password),
      "Password verifier creation failed",
      sensitiveValues,
    );
  });
}

test("comparison failure rejects without exposing native error or verifier", async (t) => {
  const password = syntheticPassword();
  const verifier = await createPasswordVerifier(password);
  const nativeDetail = syntheticPassword();
  const sensitiveValues = [
    password, verifier.saltHex, verifier.hashHex, nativeDetail,
  ];
  t.mock.method(crypto, "timingSafeEqual", () => {
    throw new Error(sensitiveValues.join(":"));
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assertSanitizedFailure(
    verifyPassword(password, verifier),
    "PASSWORD_KDF_FAILED",
    sensitiveValues,
  );
});
