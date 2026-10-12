import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Versioned AES-256-GCM encryption for provider tokens at rest.
 * Ciphertext format: `${keyId}.${iv}.${tag}.${ciphertext}` (base64url parts).
 * Multiple keys allow rotation: encrypt with the active key, decrypt with any listed key.
 * In production, keys should come from a secrets manager / KMS (see docs/DEPLOYMENT.md).
 */
export class TokenCipher {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    keySpec: string,
    private readonly activeKeyId: string,
  ) {
    for (const part of keySpec.split(",")) {
      const [id, b64] = part.split(":").map((s) => s.trim());
      if (!id || !b64) throw new Error("Malformed TOKEN_ENCRYPTION_KEYS entry");
      const key = Buffer.from(b64, "base64");
      if (key.length !== 32)
        throw new Error(`Encryption key ${id} must be 32 bytes (base64-encoded)`);
      this.keys.set(id, key);
    }
    if (!this.keys.has(activeKeyId)) throw new Error("Active encryption key not found");
  }

  encrypt(plaintext: string, aad = ""): string {
    const key = this.keys.get(this.activeKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      this.activeKeyId,
      iv.toString("base64url"),
      tag.toString("base64url"),
      ct.toString("base64url"),
    ].join(".");
  }

  decrypt(payload: string, aad = ""): string {
    const [keyId, ivB, tagB, ctB] = payload.split(".");
    if (!keyId || !ivB || !tagB || ctB === undefined) throw new Error("Malformed ciphertext");
    const key = this.keys.get(keyId);
    if (!key) throw new Error("Unknown encryption key id");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tagB, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  needsRotation(payload: string): boolean {
    return !payload.startsWith(`${this.activeKeyId}.`);
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(secret: string, input: string | Buffer): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** PKCE S256 challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
