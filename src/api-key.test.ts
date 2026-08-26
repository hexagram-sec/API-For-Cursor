import { describe, expect, it } from "vitest";

import { keyRejectionReason } from "./api-key";

const VALID_KEY = `crsr_${"a1b2c3d4".repeat(8)}`;

describe("keyRejectionReason", () => {
  it("accepts a full Cursor key", () => {
    expect(keyRejectionReason(VALID_KEY)).toBeUndefined();
  });

  it("rejects an empty value", () => {
    expect(keyRejectionReason("")).toMatch(/Enter a Cursor API key/);
  });

  it("rejects a preview masked with an ellipsis character", () => {
    expect(keyRejectionReason("crsr_24ea2e48\u2026")).toMatch(/truncated/);
  });

  it("rejects a preview masked with three dots", () => {
    expect(keyRejectionReason("crsr_24ea2e48...")).toMatch(/truncated/);
  });

  it("rejects a key containing internal whitespace", () => {
    expect(keyRejectionReason(`${VALID_KEY.slice(0, 30)} ${VALID_KEY.slice(30)}`)).toMatch(/spaces or line breaks/);
  });

  it("rejects a key with characters no Cursor key contains", () => {
    expect(keyRejectionReason(`crsr_${"!".repeat(40)}`)).toMatch(/does not look like/);
  });

  it("rejects a value too short to be a complete key", () => {
    expect(keyRejectionReason("crsr_abc")).toMatch(/too short/);
  });
});