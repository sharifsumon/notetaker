import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { OAuthClient, ReauthRequiredError } from "./oauth";

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwk: JWK;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" };
});

async function idToken(
  claims: Record<string, unknown>,
  opts: { aud?: string; iss: string; exp?: string },
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss)
    .setAudience(opts.aud ?? "client-1")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(privateKey);
}

const google = () =>
  new OAuthClient(
    "google",
    { clientId: "client-1", clientSecret: "s" },
    fetch,
    createLocalJWKSet({ keys: [jwk] }),
  );
const ms = (tenant = "common") =>
  new OAuthClient(
    "microsoft",
    { clientId: "client-1", clientSecret: "s", tenant },
    fetch,
    createLocalJWKSet({ keys: [jwk] }),
  );

describe("ID token verification", () => {
  it("accepts a valid Google token and returns the verified identity", async () => {
    const t = await idToken(
      { sub: "123", email: "a@x.com", email_verified: true, nonce: "n1", name: "A" },
      { iss: "https://accounts.google.com" },
    );
    expect(await google().verifyIdToken(t, "n1")).toEqual({
      subject: "123",
      tenant: null,
      email: "a@x.com",
      emailVerified: true,
      name: "A",
    });
  });

  it("rejects wrong nonce, audience, issuer and expired tokens", async () => {
    const ok = { sub: "1", nonce: "n1" };
    await expect(
      google().verifyIdToken(await idToken(ok, { iss: "https://accounts.google.com" }), "other"),
    ).rejects.toThrow(/Nonce/);
    await expect(
      google().verifyIdToken(
        await idToken(ok, { iss: "https://accounts.google.com", aud: "evil" }),
        "n1",
      ),
    ).rejects.toThrow();
    await expect(
      google().verifyIdToken(await idToken(ok, { iss: "https://evil.example" }), "n1"),
    ).rejects.toThrow();
    await expect(
      google().verifyIdToken(
        await idToken(ok, { iss: "https://accounts.google.com", exp: "-10m" }),
        "n1",
      ),
    ).rejects.toThrow();
  });

  it("validates Microsoft multi-tenant issuer against the token's tenant", async () => {
    const tid = "11111111-1111-1111-1111-111111111111";
    const good = await idToken(
      { tid, oid: "o1", nonce: "n", email: "u@contoso.com" },
      { iss: `https://login.microsoftonline.com/${tid}/v2.0` },
    );
    const id = await ms().verifyIdToken(good, "n");
    expect(id.subject).toBe(`${tid}:o1`);
    expect(id.emailVerified).toBe(false); // never trusted for account linking
    const spoofed = await idToken(
      { tid, oid: "o1", nonce: "n" },
      { iss: "https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/v2.0" },
    );
    await expect(ms().verifyIdToken(spoofed, "n")).rejects.toThrow();
    await expect(
      ms("33333333-3333-3333-3333-333333333333").verifyIdToken(good, "n"),
    ).rejects.toThrow(/Tenant/);
  });
});

describe("authorization URL and token exchange", () => {
  it("builds a PKCE authorization URL with state and nonce", () => {
    const u = new URL(
      google().buildAuthorizationUrl({
        redirectUri: "https://app/cb",
        scopes: ["openid", "email"],
        state: "s",
        nonce: "n",
        codeChallenge: "c",
        offline: true,
      }),
    );
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      code_challenge_method: "S256",
      code_challenge: "c",
      state: "s",
      nonce: "n",
      access_type: "offline",
      response_type: "code",
    });
  });

  it("maps invalid_grant to ReauthRequiredError", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
    const c = new OAuthClient(
      "google",
      { clientId: "c", clientSecret: "s" },
      fakeFetch,
      createLocalJWKSet({ keys: [jwk] }),
    );
    await expect(c.refresh("rt", [])).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it("sends the PKCE verifier with the code exchange", async () => {
    let body = "";
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(
        JSON.stringify({
          access_token: "a",
          refresh_token: "r",
          expires_in: 3600,
          scope: "openid email",
          id_token: "x",
        }),
      );
    }) as typeof fetch;
    const c = new OAuthClient(
      "microsoft",
      { clientId: "c", clientSecret: "s" },
      fakeFetch,
      createLocalJWKSet({ keys: [jwk] }),
    );
    const t = await c.exchangeCode("code", "https://app/cb", "verifier", ["openid"]);
    expect(t.refreshToken).toBe("r");
    expect(new URLSearchParams(body).get("code_verifier")).toBe("verifier");
  });
});
