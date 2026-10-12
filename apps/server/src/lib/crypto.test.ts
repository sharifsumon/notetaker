import { describe, expect, it } from "vitest";
import { pkceChallenge, safeEqual, TokenCipher } from "./crypto";

const k1 = Buffer.alloc(32, 1).toString("base64");
const k2 = Buffer.alloc(32, 2).toString("base64");

describe("TokenCipher", () => {
  it("round-trips and binds ciphertext to its AAD", () => {
    const c = new TokenCipher(`k1:${k1}`, "k1");
    const ct = c.encrypt("refresh-token", "user-a");
    expect(ct).not.toContain("refresh-token");
    expect(c.decrypt(ct, "user-a")).toBe("refresh-token");
    expect(() => c.decrypt(ct, "user-b")).toThrow();
  });

  it("detects tampering", () => {
    const c = new TokenCipher(`k1:${k1}`, "k1");
    const parts = c.encrypt("secret").split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => c.decrypt(parts.join("."))).toThrow();
  });

  it("supports key rotation", () => {
    const old = new TokenCipher(`k1:${k1}`, "k1");
    const ct = old.encrypt("x");
    const rotated = new TokenCipher(`k1:${k1},k2:${k2}`, "k2");
    expect(rotated.decrypt(ct)).toBe("x");
    expect(rotated.needsRotation(ct)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt("y"))).toBe(false);
  });

  it("rejects malformed keys", () => {
    expect(() => new TokenCipher(`k1:${Buffer.alloc(16).toString("base64")}`, "k1")).toThrow(/32 bytes/);
    expect(() => new TokenCipher(`k1:${k1}`, "k9")).toThrow();
  });
});

describe("helpers", () => {
  it("computes the RFC 7636 S256 PKCE challenge", () => {
    // Test vector from RFC 7636 Appendix B
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("safeEqual compares in constant time and handles length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
