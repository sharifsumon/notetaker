import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { ProviderError } from "../lib/errors";

export type IdentityProvider = "google" | "microsoft";

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  /** Microsoft tenant segment: common | organizations | consumers | <tenant-id>. */
  tenant?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
  idToken: string | null;
}

export interface VerifiedIdentity {
  subject: string;
  tenant: string | null;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/** Thrown when a refresh token was revoked/expired; the user must reconnect. */
export class ReauthRequiredError extends Error {
  constructor() {
    super("Reauthorization required");
    this.name = "ReauthRequiredError";
  }
}

interface Endpoints {
  authorize: string;
  token: string;
  jwks: string;
}

function endpoints(provider: IdentityProvider, tenant = "common"): Endpoints {
  if (provider === "google") {
    return {
      authorize: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
      jwks: "https://www.googleapis.com/oauth2/v3/certs",
    };
  }
  return {
    authorize: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    jwks: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
  };
}

/** Scopes. Sign-in requests identity only; calendar access is a separate consent (FR-01/02). */
export const SIGN_IN_SCOPES: Record<IdentityProvider, string[]> = {
  google: ["openid", "email", "profile"],
  microsoft: ["openid", "email", "profile"],
};
export const CALENDAR_SCOPES: Record<IdentityProvider, string[]> = {
  google: ["openid", "email", "https://www.googleapis.com/auth/calendar.events.readonly"],
  microsoft: ["openid", "email", "offline_access", "https://graph.microsoft.com/Calendars.Read"],
};

/**
 * OAuth 2.0 / OpenID Connect client for Google and Microsoft (authorization code + PKCE).
 * ID tokens are verified with the provider's JWKS (issuer, audience, expiry, nonce).
 */
export class OAuthClient {
  private readonly ep: Endpoints;
  private jwks: JWTVerifyGetKey;

  constructor(
    readonly provider: IdentityProvider,
    private readonly cfg: OAuthClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    jwks?: JWTVerifyGetKey,
  ) {
    this.ep = endpoints(provider, cfg.tenant);
    this.jwks = jwks ?? createRemoteJWKSet(new URL(this.ep.jwks));
  }

  buildAuthorizationUrl(opts: {
    redirectUri: string;
    scopes: string[];
    state: string;
    nonce: string;
    codeChallenge: string;
    offline: boolean;
    loginHint?: string;
  }): string {
    const p = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: opts.redirectUri,
      response_type: "code",
      scope: opts.scopes.join(" "),
      state: opts.state,
      nonce: opts.nonce,
      code_challenge: opts.codeChallenge,
      code_challenge_method: "S256",
    });
    if (this.provider === "google") {
      if (opts.offline) {
        p.set("access_type", "offline");
        p.set("prompt", "consent");
      } else {
        p.set("prompt", "select_account");
      }
    } else {
      p.set("response_mode", "query");
      p.set("prompt", "select_account");
    }
    if (opts.loginHint) p.set("login_hint", opts.loginHint);
    return `${this.ep.authorize}?${p.toString()}`;
  }

  private async tokenRequest(body: URLSearchParams): Promise<TokenSet> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.ep.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ProviderError("oauth_unavailable", "Token endpoint unreachable", true);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (json.error === "invalid_grant") throw new ReauthRequiredError();
      throw new ProviderError("oauth_error", `Token endpoint HTTP ${res.status}`, res.status >= 500 || res.status === 429, res.status);
    }
    if (typeof json.access_token !== "string") throw new ProviderError("oauth_error", "No access token", false);
    return {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
      expiresAt: new Date(Date.now() + (Number(json.expires_in) || 3600) * 1000),
      scopes: typeof json.scope === "string" ? json.scope.split(" ").filter(Boolean) : [],
      idToken: typeof json.id_token === "string" ? json.id_token : null,
    };
  }

  exchangeCode(code: string, redirectUri: string, codeVerifier: string, scopes: string[]): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code_verifier: codeVerifier,
    });
    if (this.provider === "microsoft") body.set("scope", scopes.join(" "));
    return this.tokenRequest(body);
  }

  refresh(refreshToken: string, scopes: string[]): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
    if (this.provider === "microsoft") body.set("scope", scopes.join(" "));
    return this.tokenRequest(body);
  }

  /** Best-effort token revocation (Google only; Microsoft has no per-token revocation endpoint). */
  async revoke(token: string): Promise<void> {
    if (this.provider !== "google") return;
    await this.fetchImpl("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }

  async verifyIdToken(idToken: string, expectedNonce: string): Promise<VerifiedIdentity> {
    let payload: JWTPayload;
    try {
      const r = await jwtVerify(idToken, this.jwks, {
        audience: this.cfg.clientId,
        issuer: this.provider === "google" ? ["https://accounts.google.com", "accounts.google.com"] : undefined,
        clockTolerance: 60,
      });
      payload = r.payload;
    } catch {
      throw new ProviderError("oauth_invalid_id_token", "ID token verification failed", false);
    }
    if (payload.nonce !== expectedNonce) throw new ProviderError("oauth_invalid_id_token", "Nonce mismatch", false);

    if (this.provider === "microsoft") {
      // Multi-tenant: issuer must match the token's own tenant id.
      const tid = typeof payload.tid === "string" ? payload.tid : null;
      if (!tid || payload.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) {
        throw new ProviderError("oauth_invalid_id_token", "Issuer mismatch", false);
      }
      const configured = this.cfg.tenant ?? "common";
      if (!["common", "organizations", "consumers"].includes(configured) && configured !== tid) {
        throw new ProviderError("oauth_invalid_id_token", "Tenant not allowed", false);
      }
      const oid = typeof payload.oid === "string" ? payload.oid : null;
      if (!oid) throw new ProviderError("oauth_invalid_id_token", "Missing oid", false);
      // Microsoft's `email` claim is not guaranteed verified; never used for account linking.
      const email = typeof payload.email === "string" ? payload.email : null;
      return {
        subject: `${tid}:${oid}`,
        tenant: tid,
        email,
        emailVerified: false,
        name: typeof payload.name === "string" ? payload.name : null,
      };
    }
    if (typeof payload.sub !== "string") throw new ProviderError("oauth_invalid_id_token", "Missing sub", false);
    return {
      subject: payload.sub,
      tenant: null,
      email: typeof payload.email === "string" ? payload.email : null,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === "string" ? payload.name : null,
    };
  }
}
