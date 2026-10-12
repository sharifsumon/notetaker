import { createHash } from "node:crypto";
import { TokenCipher, pkceChallenge, randomToken } from "../lib/crypto";

export interface OAuthState {
  state: string;
  nonce: string;
  verifier: string;
  purpose: "login" | "calendar";
  provider: string;
  userId?: string;
  exp: number;
}

export const OAUTH_COOKIE = "nt_oauth";
const TTL_MS = 10 * 60_000;

/**
 * Short-lived encrypted cookie carrying OAuth state, nonce and PKCE verifier between the
 * redirect and the callback. Protects against login CSRF and code/token substitution.
 */
export class OAuthStateCodec {
  private readonly cipher: TokenCipher;

  constructor(sessionSecret: string) {
    const key = createHash("sha256").update(`oauth-state:${sessionSecret}`).digest("base64");
    this.cipher = new TokenCipher(`s1:${key}`, "s1");
  }

  create(purpose: OAuthState["purpose"], provider: string, userId?: string) {
    const st: OAuthState = {
      state: randomToken(24),
      nonce: randomToken(24),
      verifier: randomToken(48),
      purpose,
      provider,
      userId,
      exp: Date.now() + TTL_MS,
    };
    return { st, cookie: this.cipher.encrypt(JSON.stringify(st), "oauth"), challenge: pkceChallenge(st.verifier) };
  }

  read(cookie: string | undefined): OAuthState | null {
    if (!cookie) return null;
    try {
      const st = JSON.parse(this.cipher.decrypt(cookie, "oauth")) as OAuthState;
      return st.exp > Date.now() ? st : null;
    } catch {
      return null;
    }
  }
}
