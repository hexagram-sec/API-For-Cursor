import { afterEach, describe, expect, it } from "vitest";
import {
  markModelCheck,
  modelOutcome,
  modelOutcomes,
  parseStatusStore,
  recordModelCheck,
  restoreModelCheck,
  setModelStatusStorageForTest,
  settledCount
} from "./model-status";

class MemoryStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

afterEach(() => {
  setModelStatusStorageForTest(null);
});

describe("model status store", () => {
  it("ignores inflight and cancelled payloads when parsing", () => {
    expect(
      parseStatusStore(
        JSON.stringify({
          relays: {
            "relay-1": {
              "composer-2.5": { model: "composer-2.5", status: "ok", ms: 12, testedAt: 1 },
              "gpt-5.5": { model: "gpt-5.5", status: "running", testedAt: 2 }
            }
          }
        })
      )
    ).toEqual({
      relays: {
        "relay-1": {
          "composer-2.5": { model: "composer-2.5", status: "ok", ms: 12, testedAt: 1 }
        }
      }
    });
  });

  it("keeps the last settled probe and overlays an in-flight check", () => {
    setModelStatusStorageForTest(new MemoryStorage());
    recordModelCheck({ model: "composer-2.5", status: "ok", ms: 40, reply: "pong" }, "relay-a", 1000);
    expect(modelOutcome("composer-2.5", "relay-a")).toMatchObject({ status: "ok", ms: 40, testedAt: 1000 });

    markModelCheck("composer-2.5", "running", "relay-a");
    expect(modelOutcome("composer-2.5", "relay-a")?.status).toBe("running");

    restoreModelCheck("composer-2.5", "relay-a");
    expect(modelOutcome("composer-2.5", "relay-a")).toMatchObject({ status: "ok", ms: 40 });
  });

  it("does not let a cancelled run overwrite the last test", () => {
    setModelStatusStorageForTest(new MemoryStorage());
    recordModelCheck({ model: "gpt-5.5", status: "error", error: "boom" }, "relay-a", 1);
    recordModelCheck({ model: "gpt-5.5", status: "cancelled" }, "relay-a", 2);
    expect(modelOutcome("gpt-5.5", "relay-a")).toMatchObject({ status: "error", error: "boom" });
  });

  it("isolates results per relay key", () => {
    setModelStatusStorageForTest(new MemoryStorage());
    recordModelCheck({ model: "composer-2.5", status: "ok" }, "relay-a", 1);
    recordModelCheck({ model: "composer-2.5", status: "error", error: "nope" }, "relay-b", 1);
    expect(modelOutcomes("relay-a").get("composer-2.5")?.status).toBe("ok");
    expect(modelOutcomes("relay-b").get("composer-2.5")?.status).toBe("error");
    expect(settledCount(["composer-2.5"], "relay-a")).toEqual({ ok: 1, error: 0, tested: 1 });
  });
});
