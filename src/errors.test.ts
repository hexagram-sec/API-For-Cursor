import { describe, expect, it } from "vitest";

import { errorFromData, errorStatus, RequestError } from "./errors";

// Captured verbatim from `POST /v1/chat/completions` with `stream: true` and a
// key the upstream rejects. The transport status is 200, so 401 only appears
// inside this frame.
const AUTH_FAILURE_FRAME =
  '{"error":{"message":"Missing or invalid authorization","type":"cursor_error","code":"unauthorized","status":401}}';

describe("errorStatus", () => {
  // The chat UI keys its "re-enter your key" recovery off this helper, so a
  // regression here silently turns an auth failure back into a dead-end banner.
  it("reads status off an error instance", () => {
    expect(errorStatus(new RequestError("nope", 401))).toBe(401);
  });

  it("reads status off a plain object, independent of class identity", () => {
    expect(errorStatus({ status: 401 })).toBe(401);
  });

  it("returns undefined when no numeric status is present", () => {
    expect(errorStatus(new Error("boom"))).toBeUndefined();
    expect(errorStatus({ status: "401" })).toBeUndefined();
    expect(errorStatus(null)).toBeUndefined();
    expect(errorStatus("401")).toBeUndefined();
  });
});

describe("errorFromData", () => {
  it("recovers the 401 from a streamed auth failure frame", () => {
    const error = errorFromData(AUTH_FAILURE_FRAME, "fallback");
    expect(error.message).toBe("Missing or invalid authorization");
    expect(errorStatus(error)).toBe(401);
  });

  it("keeps the message but reports no status when the frame omits one", () => {
    const error = errorFromData('{"error":{"message":"Stream failed","code":"cursor_stream_error"}}', "fallback");
    expect(error.message).toBe("Stream failed");
    expect(errorStatus(error)).toBeUndefined();
  });

  it("falls back when the frame is empty", () => {
    expect(errorFromData("", "fallback").message).toBe("fallback");
  });

  it("uses the raw text when the frame is not JSON", () => {
    expect(errorFromData("not json", "fallback").message).toBe("not json");
  });

  it("reads a top-level message when there is no error object", () => {
    expect(errorFromData('{"message":"top level"}', "fallback").message).toBe("top level");
  });

  it("ignores a non-numeric status", () => {
    const error = errorFromData('{"error":{"message":"weird","status":"401"}}', "fallback");
    expect(errorStatus(error)).toBeUndefined();
  });
});
