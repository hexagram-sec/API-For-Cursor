import { describe, expect, it } from "vitest";
import {
  clampConcurrency,
  modelsFromListPayload,
  probeRequestBody,
  probeSessionKey,
  randomId,
  runWithConcurrency,
  summarizeProbeResponse
} from "./lab-probe";

describe("model lab probe helpers", () => {
  it("builds a non-streaming chat completion body", () => {
    expect(probeRequestBody("gpt-5.5", "pong")).toEqual({
      model: "gpt-5.5",
      stream: false,
      messages: [{ role: "user", content: "pong" }]
    });
  });

  it("keeps lab sessions isolated per model run", () => {
    expect(probeSessionKey("composer-2.5", "abc")).toBe("lab:composer-2.5:abc");
  });

  it("uses crypto.randomUUID when the browser provides it", () => {
    expect(randomId({ randomUUID: () => "11111111-2222-4333-8444-555555555555" })).toBe(
      "11111111-2222-4333-8444-555555555555"
    );
  });

  it("builds a UUID from getRandomValues when randomUUID is missing", () => {
    const id = randomId({
      getRandomValues(bytes) {
        bytes.fill(0xab);
        return bytes;
      }
    });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("falls back without Web Crypto", () => {
    expect(randomId({})).toMatch(/^id-/);
  });

  it("clamps parallel probe counts", () => {
    expect(clampConcurrency(8)).toBe(8);
    expect(clampConcurrency(0)).toBe(1);
    expect(clampConcurrency(999)).toBe(64);
    expect(clampConcurrency("12")).toBe(12);
    expect(clampConcurrency("nope")).toBe(8);
  });

  it("runs a bounded worker pool and stops handing out work after abort", async () => {
    const seen: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const abort = new AbortController();

    await runWithConcurrency(
      ["a", "b", "c", "d", "e", "f"],
      2,
      async (item) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        seen.push(item);
        if (seen.length === 2) abort.abort();
        await Promise.resolve();
        inFlight -= 1;
      },
      abort.signal
    );

    expect(maxInFlight).toBe(2);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.length).toBeLessThan(6);
  });

  it("reads OpenAI-style model lists", () => {
    expect(
      modelsFromListPayload({
        data: [
          { id: "composer-2.5", name: "Composer 2.5" },
          { id: "gpt-5.5" },
          { name: "missing-id" }
        ]
      })
    ).toEqual([
      { id: "composer-2.5", name: "Composer 2.5" },
      { id: "gpt-5.5", name: "gpt-5.5" }
    ]);
  });

  it("records a successful completion", () => {
    expect(
      summarizeProbeResponse(
        "composer-2.5",
        200,
        JSON.stringify({ choices: [{ message: { content: "pong" } }] }),
        412
      )
    ).toEqual({
      model: "composer-2.5",
      status: "ok",
      httpStatus: 200,
      ms: 412,
      reply: "pong"
    });
  });

  it("surfaces Cursor SDK failures from the JSON error body", () => {
    expect(
      summarizeProbeResponse(
        "gpt-5.5",
        503,
        JSON.stringify({
          error: { message: "Cursor SDK run failed", type: "cursor_sdk_error", code: "cursor_sdk_error" }
        }),
        88
      )
    ).toEqual({
      model: "gpt-5.5",
      status: "error",
      httpStatus: 503,
      ms: 88,
      error: "Cursor SDK run failed"
    });
  });

  it("treats an empty 200 as a failure", () => {
    expect(summarizeProbeResponse("default", 200, JSON.stringify({ choices: [{ message: { content: "  " } }] }), 10)).toMatchObject({
      model: "default",
      status: "error",
      error: "Empty reply"
    });
  });
});
