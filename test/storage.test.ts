/**
 * Pluggable storage tests.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileKVStore,
  MemoryKVStore,
  kvSessionPersistence,
} from "../src/storage/index.js";

// ============ MemoryKVStore ============

describe("MemoryKVStore", () => {
  it("set / get / delete", () => {
    const s = new MemoryKVStore();
    s.set("k", { value: 1 });
    expect(s.get("k")).toEqual({ value: 1 });
    expect(s.delete("k")).toBe(true);
    expect(s.get("k")).toBeUndefined();
  });

  it("respects TTL", () => {
    const s = new MemoryKVStore();
    s.set("k", "v", 10); // 10ms
    expect(s.get("k")).toBe("v");
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(s.get("k")).toBeUndefined();
        resolve();
      }, 50);
    });
  });

  it("keys() filters by prefix", () => {
    const s = new MemoryKVStore();
    s.set("user:1", 1);
    s.set("user:2", 2);
    s.set("group:1", 3);
    expect(s.keys("user:")).toEqual(["user:1", "user:2"]);
    expect(s.keys()).toHaveLength(3);
  });

  it("clear() with prefix removes matching keys", () => {
    const s = new MemoryKVStore();
    s.set("a:1", 1);
    s.set("a:2", 2);
    s.set("b:1", 3);
    s.clear("a:");
    expect(s.keys()).toEqual(["b:1"]);
  });
});

// ============ FileKVStore ============

describe("FileKVStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-kv-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("persists across instances", () => {
    const s1 = new FileKVStore({ dir, fileName: "test.json", saveThrottleMs: 0 });
    s1.set("k", { hello: "world" });
    s1.flush();

    const s2 = new FileKVStore({ dir, fileName: "test.json" });
    expect(s2.get("k")).toEqual({ hello: "world" });
  });

  it("respects TTL after reload", async () => {
    const s1 = new FileKVStore({ dir, fileName: "ttl.json", saveThrottleMs: 0 });
    s1.set("expired", "x", 5); // expires in 5ms
    s1.set("fresh", "y", 60_000);
    s1.flush();

    // Wait for the short-TTL key to expire on disk.
    await new Promise<void>((r) => setTimeout(r, 50));

    const s2 = new FileKVStore({ dir, fileName: "ttl.json" });
    expect(s2.get("expired")).toBeUndefined();
    expect(s2.get("fresh")).toBe("y");
  });
});

// ============ kvSessionPersistence ============

describe("kvSessionPersistence", () => {
  it("plugs into a KVStore", () => {
    const store = new MemoryKVStore();
    const port = kvSessionPersistence({ store, accountId: "acc1" });

    expect(port.load()).toBeNull();

    port.save({ sessionId: "s1", lastSeq: 42 });
    expect(port.load()).toEqual({ sessionId: "s1", lastSeq: 42 });

    port.clear();
    expect(port.load()).toBeNull();
  });

  it("uses prefix to namespace per account", () => {
    const store = new MemoryKVStore();
    const a = kvSessionPersistence({ store, accountId: "alice" });
    const b = kvSessionPersistence({ store, accountId: "bob" });

    a.save({ sessionId: "s-alice", lastSeq: 1 });
    b.save({ sessionId: "s-bob", lastSeq: 2 });

    expect(a.load()?.sessionId).toBe("s-alice");
    expect(b.load()?.sessionId).toBe("s-bob");
  });
});
