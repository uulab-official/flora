import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "@app-ops/db";
import { preparePrivateStore, verifyPrivateStore, resolvePrivateStorePath } from "../src/private-store.ts";

const posix = process.platform !== "win32";
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const mask = process.umask();
  const root = await fs.mkdtemp(join(await fs.realpath(os.tmpdir()), "flora-private-store-"));
  if (posix) await fs.chmod(root, 0o700);
  try { await run(root); }
  finally { process.umask(mask); await fs.rm(root, { recursive: true, force: true }); }
}
async function mode(path: string) { return (await fs.lstat(path)).mode & 0o7777; }

test("private default store lives under the profile and never broadens access", async t => {
  await fixture(async root => {
    t.mock.method(os, "homedir", () => root);
    if (posix) process.umask(0o022);
    const dbPath = await preparePrivateStore();
    assert.equal(dbPath, join(root, ".flora", "dogfood", "state.db"));
    if (posix) {
      assert.equal(process.umask(), 0o077);
      for (const dir of [join(root, ".flora"), join(root, ".flora", "dogfood")]) assert.equal(await mode(dir), 0o700);
      assert.equal(await mode(dbPath), 0o600);
    }
    const db = openDatabase(dbPath);
    try {
      db.exec("CREATE TABLE synthetic(value TEXT); BEGIN IMMEDIATE; INSERT INTO synthetic VALUES('fixture')");
      if (posix) assert.equal(await mode(dbPath + "-journal"), 0o600);
      await verifyPrivateStore(dbPath);
      db.exec("COMMIT; PRAGMA journal_mode=WAL; INSERT INTO synthetic VALUES('fixture-2')");
      if (posix) for (const suffix of ["", "-wal", "-shm"]) assert.equal(await mode(dbPath + suffix), 0o600);
      await verifyPrivateStore(dbPath);
    } finally { db.close(); }
    assert.equal(await preparePrivateStore(), dbPath);
  });
});

test("custom POSIX stores use an existing private parent or one new private leaf", { skip: !posix }, async () => {
  await fixture(async root => {
    for (const file of [join(root, "state.db"), join(root, "new-leaf", "state.db")]) {
      assert.equal(await preparePrivateStore(file), resolve(file));
      assert.equal(await mode(file), 0o600);
    }
    assert.equal(await mode(join(root, "new-leaf")), 0o700);
    await assert.rejects(preparePrivateStore(join(root, "missing", "nested", "state.db")), { code: "PRIVATE_STORE_UNSAFE" });
    await assert.rejects(fs.lstat(join(root, "missing")), { code: "ENOENT" });
  });
});

test("unsafe existing directory modes are rejected without chmod or file access", { skip: !posix }, async t => {
  await fixture(async root => {
    const directory = join(root, "shared"); await fs.mkdir(directory, { mode: 0o755 }); await fs.chmod(directory, 0o755);
    const path = join(directory, "state.db"); await fs.writeFile(path, "synthetic", { mode: 0o600 });
    const open = t.mock.method(fs, "open", () => { throw new Error("unsafe file was opened"); });
    await assert.rejects(preparePrivateStore(path), { code: "PRIVATE_STORE_UNSAFE", message: "PRIVATE_STORE_UNSAFE" });
    assert.equal(open.mock.callCount(), 0); assert.equal(await mode(directory), 0o755);
    assert.equal(await fs.readFile(path, "utf8"), "synthetic");
  });
});

for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  test(`unsafe ${suffix || "database"} mode is rejected without changing bytes or modes`, { skip: !posix }, async t => {
    await fixture(async root => {
      const path = join(root, "state.db"), target = path + suffix;
      await fs.writeFile(target, "synthetic-private", { mode: 0o644 }); await fs.chmod(target, 0o644);
      const open = t.mock.method(fs, "open", () => { throw new Error("unsafe file was opened"); });
      await assert.rejects(preparePrivateStore(path), { code: "PRIVATE_STORE_UNSAFE" });
      assert.equal(open.mock.callCount(), 0); assert.equal(await mode(target), 0o644);
      assert.equal(await fs.readFile(target, "utf8"), "synthetic-private");
      if (suffix) await assert.rejects(fs.lstat(path), { code: "ENOENT" });
    });
  });

  test(`symlinked ${suffix || "database"} is rejected without touching its target`, { skip: !posix }, async () => {
    await fixture(async root => {
      const path = join(root, "state.db"), target = join(root, "target");
      await fs.writeFile(target, "untouched", { mode: 0o600 }); await fs.symlink(target, path + suffix);
      await assert.rejects(preparePrivateStore(path), { code: "PRIVATE_STORE_UNSAFE" });
      assert.equal(await fs.readFile(target, "utf8"), "untouched");
      assert.equal((await fs.lstat(path + suffix)).isSymbolicLink(), true);
    });
  });
}

test("symlink ancestors and mutable ancestor directories are rejected", { skip: !posix }, async () => {
  await fixture(async root => {
    const actual = join(root, "actual"), alias = join(root, "alias");
    await fs.mkdir(actual, { mode: 0o700 }); await fs.symlink(actual, alias);
    await assert.rejects(preparePrivateStore(join(alias, "state.db")), { code: "PRIVATE_STORE_UNSAFE" });
    const shared = join(root, "shared"), privateChild = join(shared, "private");
    await fs.mkdir(shared, { mode: 0o777 }); await fs.chmod(shared, 0o777); await fs.mkdir(privateChild, { mode: 0o700 });
    await assert.rejects(preparePrivateStore(join(privateChild, "state.db")), { code: "PRIVATE_STORE_UNSAFE" });
    assert.deepEqual(await fs.readdir(actual), []); assert.deepEqual(await fs.readdir(privateChild), []);
  });
});

test("hardlinked database and sidecars are rejected", { skip: !posix }, async () => {
  await fixture(async root => {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const directory = join(root, suffix || "database"); await fs.mkdir(directory, { mode: 0o700 });
      const path = join(directory, "state.db"), target = join(directory, "original");
      await fs.writeFile(target, "untouched", { mode: 0o600 }); await fs.link(target, path + suffix);
      await assert.rejects(preparePrivateStore(path), { code: "PRIVATE_STORE_UNSAFE" });
      assert.equal(await fs.readFile(target, "utf8"), "untouched"); assert.equal((await fs.lstat(target)).nlink, 2);
    }
  });
});

test("foreign directory and file owners fail before opening a database", { skip: !posix }, async t => {
  await fixture(async root => {
    const path = join(root, "state.db"); await fs.writeFile(path, "synthetic", { mode: 0o600 });
    const lstat = fs.lstat.bind(fs);
    for (const foreign of [root, path]) {
      const mock = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
        const value = await lstat(...args);
        if (String(args[0]) === foreign) Object.assign(value, { uid: process.getuid!() + 1 });
        return value;
      });
      await assert.rejects(preparePrivateStore(path), { code: "PRIVATE_STORE_UNSAFE" });
      mock.mock.restore();
    }
    assert.equal(await fs.readFile(path, "utf8"), "synthetic");
  });
});

test("existing default directories must already be private", { skip: !posix }, async t => {
  await fixture(async root => {
    t.mock.method(os, "homedir", () => root);
    await fs.mkdir(join(root, ".flora"), { mode: 0o755 }); await fs.chmod(join(root, ".flora"), 0o755);
    await assert.rejects(preparePrivateStore(), { code: "PRIVATE_STORE_UNSAFE" });
    assert.equal(await mode(join(root, ".flora")), 0o755);
    assert.deepEqual(await fs.readdir(join(root, ".flora")), []);
  });
});

test("an explicit path into the default store cannot bypass dedicated parent privacy", { skip: !posix }, async t => {
  await fixture(async root => {
    t.mock.method(os, "homedir", () => root);
    const flora = join(root, ".flora"), directory = join(flora, "dogfood");
    await fs.mkdir(flora, { mode: 0o755 }); await fs.chmod(flora, 0o755);
    await fs.mkdir(directory, { mode: 0o700 });
    const open = t.mock.method(fs, "open", () => { throw new Error("unsafe ancestry was opened"); });
    await assert.rejects(preparePrivateStore(join(directory, "state.db")), { code: "PRIVATE_STORE_UNSAFE" });
    assert.equal(open.mock.callCount(), 0);
    assert.deepEqual(await fs.readdir(directory), []);
  });
});

test("an explicit default path creates a missing dedicated leaf under private flora", async t => {
  await fixture(async root => {
    t.mock.method(os, "homedir", () => root);
    await fs.mkdir(join(root, ".flora"), { mode: 0o700 });
    const expected = join(root, ".flora", "dogfood", "state.db");
    assert.equal(await preparePrivateStore(expected), expected);
    assert.equal(await preparePrivateStore(), expected);
    if (posix) {
      assert.equal(await mode(join(root, ".flora", "dogfood")), 0o700);
      assert.equal(await mode(expected), 0o600);
    }
  });
});

test("opening an existing store rechecks inode identity before returning it", { skip: !posix }, async t => {
  await fixture(async root => {
    const path = join(root, "state.db"); await fs.writeFile(path, "original", { mode: 0o600 });
    const open = fs.open.bind(fs);
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      await fs.rename(path, path + ".old"); await fs.writeFile(path, "replacement", { mode: 0o600 });
      return file;
    });
    await assert.rejects(preparePrivateStore(path), { code: "PRIVATE_STORE_UNSAFE" });
    assert.equal(await fs.readFile(path, "utf8"), "replacement");
    assert.equal(await fs.readFile(path + ".old", "utf8"), "original");
  });
});

test("Windows path policy confines custom stores to the dedicated profile directory", () => {
  const profile = "C:\\Users\\Synthetic";
  assert.equal(resolvePrivateStorePath(undefined, profile, "win32"), "C:\\Users\\Synthetic\\.flora\\dogfood\\state.db");
  assert.equal(resolvePrivateStorePath("C:\\Users\\Synthetic\\.flora\\dogfood\\nested\\state.db", profile, "win32"), "C:\\Users\\Synthetic\\.flora\\dogfood\\nested\\state.db");
  for (const path of ["C:\\other\\state.db", "C:\\Users\\Synthetic\\state.db", "C:\\Users\\Synthetic\\.flora\\dogfood-other\\state.db", "C:\\Users\\Synthetic\\.flora\\dogfood\\..\\state.db", "\\\\server\\share\\state.db", "\\\\?\\C:\\Users\\Synthetic\\.flora\\dogfood\\state.db", "C:\\Users\\Synthetic\\.flora\\dogfood\\state.db:stream", "C:\\Users\\Synthetic\\.flora\\dogfood\\CON", "C:\\Users\\Synthetic\\.flora\\dogfood\\state.db.", "C:relative.db"]) {
    assert.throws(() => resolvePrivateStorePath(path, profile, "win32"), { code: "PRIVATE_STORE_UNSAFE" });
  }
});

test("Windows path policy rejects reserved superscript device names before I/O", () => {
  const profile = "C:\\Users\\Synthetic";
  for (const name of ["COM¹", "COM².db", "COM³.log", "LPT¹", "LPT².db", "LPT³.log"]) {
    assert.throws(() => resolvePrivateStorePath(profile + "\\.flora\\dogfood\\" + name, profile, "win32"), { code: "PRIVATE_STORE_UNSAFE" });
  }
});

test("Windows preparation inherits profile access and rejects junctions", { skip: posix }, async t => {
  await fixture(async root => {
    t.mock.method(os, "homedir", () => root);
    t.mock.method(fs, "chmod", () => { throw new Error("must not change access permissions"); });
    t.mock.method(fs, "chown", () => { throw new Error("must not change ownership"); });
    const dbPath = await preparePrivateStore();
    const target = join(root, "junction-target"); await fs.mkdir(target);
    const junction = join(root, ".flora", "dogfood", "junction"); await fs.symlink(target, junction, "junction");
    await assert.rejects(preparePrivateStore(join(junction, "state.db")), { code: "PRIVATE_STORE_UNSAFE" });
    await assert.rejects(preparePrivateStore(join(root, "outside.db")), { code: "PRIVATE_STORE_UNSAFE" });
    assert.equal(await preparePrivateStore(join(root, ".flora", "dogfood", "nested", "state.db")), join(root, ".flora", "dogfood", "nested", "state.db"));
    await verifyPrivateStore(dbPath);
    assert.deepEqual(await fs.readdir(target), []);
  });
});

test("post-operation verification catches an unsafe sidecar without repairing it", { skip: !posix }, async () => {
  await fixture(async root => {
    const path = await preparePrivateStore(join(root, "state.db"));
    await fs.writeFile(path + "-wal", "synthetic", { mode: 0o600 }); await fs.chmod(path + "-wal", 0o644);
    await assert.rejects(verifyPrivateStore(path), { code: "PRIVATE_STORE_UNSAFE" });
    assert.equal(await mode(path + "-wal"), 0o644);
  });
});
