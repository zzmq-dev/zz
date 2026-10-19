// Login: Cloudflare OAuth + Google OAuth + GitHub OAuth. All three are
// standard OAuth 2.0 authorization-code flow. Cloudflare's token is
// kept (encrypted) specifically so a later feature can call the
// Cloudflare API as the signed-in user; Google's and GitHub's are
// kept the same way for symmetry, though only GitHub's has a planned
// consumer so far (#14's GitHub-history trust bootstrap needs the
// access token to read the signed-in user's real repo/commit history,
// not just the one-time profile fetch below).
//
// GitHub was deliberately left out originally -- zz aims to replace
// GitHub, not depend on it for identity -- but #13 is a narrower,
// justified exception: proving a *claimed* GitHub username is real
// (not a self-reported string anyone could type) is what #14's trust
// bootstrap needs, which is verifying an external fact about an
// existing zz identity, not using GitHub as the identity system
// itself the way `zz login` with Cloudflare/Google is.
//
// Cloudflare endpoints confirmed against developers.cloudflare.com's
// own OAuth docs (fundamentals/oauth/integrate-with-cloudflare);
// "User Details Read" is scope id "user-details.read", confirmed via
// GET https://api.cloudflare.com/client/v4/oauth/scopes. The full
// login flow (authorize -> consent -> token exchange -> profile fetch
// -> account/session creation) is verified live end to end as of
// 2026-10-12, including real email/name via GET /client/v4/user (the
// OIDC-shaped /oauth2/userinfo returns no profile data at all -- see
// the cloudflare provider's own comment for why that endpoint isn't
// used here).
import { createHash, randomBytes } from "node:crypto";

export interface OAuthEnv {
  CF_OAUTH_CLIENT_ID?: string;
  CF_OAUTH_CLIENT_SECRET?: string;
  CF_OAUTH_REDIRECT_URI?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  GITHUB_OAUTH_REDIRECT_URI?: string;
  TOKEN_ENCRYPTION_KEY?: string; // base64, 32 bytes, for AES-GCM
}

export type Provider = "cloudflare" | "google" | "github";

export interface ProviderIdentity {
  subject: string;
  email: string | null;
  displayName: string;
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number | null;
}

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  clientId(env: OAuthEnv): string;
  clientSecret(env: OAuthEnv): string;
  redirectUri(env: OAuthEnv): string;
  extraAuthorizeParams?: Record<string, string>;
  parseUserInfo(json: unknown): { subject: string; email: string | null; displayName: string };
}

const PROVIDERS: Record<Provider, ProviderConfig> = {
  cloudflare: {
    authorizeUrl: "https://dash.cloudflare.com/oauth2/auth",
    tokenUrl: "https://dash.cloudflare.com/oauth2/token",
    // Not the OIDC-shaped /oauth2/userinfo (confirmed live to return
    // only {sub, iss, aud, ...}, no email/name, despite the
    // "user-details.read" scope's name) -- the OAuth access token also
    // works as a Bearer token against the real REST API, confirmed
    // live via /dev-cf-userinfo-raw: GET /client/v4/user returns the
    // full account profile. Only email/name/username are used below;
    // the rest of that response (org membership, full permissions
    // list, billing/subscription flags) is deliberately not requested
    // further or stored.
    userinfoUrl: "https://api.cloudflare.com/client/v4/user",
    scope: "user-details.read",
    clientId: (env) => required(env.CF_OAUTH_CLIENT_ID, "CF_OAUTH_CLIENT_ID"),
    clientSecret: (env) => required(env.CF_OAUTH_CLIENT_SECRET, "CF_OAUTH_CLIENT_SECRET"),
    redirectUri: (env) => required(env.CF_OAUTH_REDIRECT_URI, "CF_OAUTH_REDIRECT_URI"),
    parseUserInfo: (json) => {
      const j = json as { result?: { id?: string; email?: string; first_name?: string | null; last_name?: string | null; username?: string } };
      const r = j.result;
      if (!r?.id) throw new Error(`Cloudflare /client/v4/user response had no "result.id": ${JSON.stringify(json)}`);
      const fullName = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
      // email before username: Cloudflare's `username` is often itself
      // an opaque, auto-generated hash (confirmed live) when no
      // first/last name is set, no more readable than the raw id.
      return { subject: r.id, email: r.email ?? null, displayName: fullName || r.email || r.username || `cf-${r.id.slice(0, 8)}` };
    },
  },
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
    clientId: (env) => required(env.GOOGLE_OAUTH_CLIENT_ID, "GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: (env) => required(env.GOOGLE_OAUTH_CLIENT_SECRET, "GOOGLE_OAUTH_CLIENT_SECRET"),
    redirectUri: (env) => required(env.GOOGLE_OAUTH_REDIRECT_URI, "GOOGLE_OAUTH_REDIRECT_URI"),
    parseUserInfo: (json) => {
      const j = json as { sub: string; email?: string; name?: string };
      return { subject: j.sub, email: j.email ?? null, displayName: j.name ?? j.email ?? j.sub };
    },
  },
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    // read:user for the profile fetch below; user:email is requested
    // too but not actually used yet -- GET /user's own `email` field
    // is null whenever the user has made their email private, and
    // getting the verified primary one regardless needs a second call
    // (GET /user/emails) this first pass doesn't make. displayName
    // falls back to the GitHub login (always present) same as every
    // other provider here falls back to *something* real rather than
    // leaving a blank.
    userinfoUrl: "https://api.github.com/user",
    scope: "read:user user:email",
    clientId: (env) => required(env.GITHUB_OAUTH_CLIENT_ID, "GITHUB_OAUTH_CLIENT_ID"),
    clientSecret: (env) => required(env.GITHUB_OAUTH_CLIENT_SECRET, "GITHUB_OAUTH_CLIENT_SECRET"),
    redirectUri: (env) => required(env.GITHUB_OAUTH_REDIRECT_URI, "GITHUB_OAUTH_REDIRECT_URI"),
    parseUserInfo: (json) => {
      const j = json as { id: number; login: string; email?: string | null; name?: string | null };
      return { subject: String(j.id), email: j.email ?? null, displayName: j.name ?? j.login };
    },
  },
};

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing Worker secret/var: ${name}`);
  return value;
}

export function buildAuthorizeUrl(provider: Provider, env: OAuthEnv, state: string): string {
  const config = PROVIDERS[provider];
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId(env));
  url.searchParams.set("redirect_uri", config.redirectUri(env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  for (const [k, v] of Object.entries(config.extraAuthorizeParams ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

export async function exchangeCodeForIdentity(provider: Provider, env: OAuthEnv, code: string): Promise<ProviderIdentity> {
  const config = PROVIDERS[provider];
  const clientId = config.clientId(env);
  const clientSecret = config.clientSecret(env);
  const basic = btoa(`${clientId}:${clientSecret}`);
  const tokenResp = await fetch(config.tokenUrl, {
    method: "POST",
    // Basic Auth (what CF/Google's own docs confirm) and client_id/
    // client_secret in the body (what GitHub's own docs confirm,
    // without explicitly saying Basic Auth also works) -- sent
    // together so every provider's own documented mechanism is
    // actually used, not assumed to also accept the other one.
    // "accept: application/json" is GitHub-specific (its default
    // response is form-urlencoded, not JSON, without this) but
    // harmless for CF/Google, which already return JSON regardless.
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri(env), client_id: clientId, client_secret: clientSecret }),
  });
  if (!tokenResp.ok) throw new Error(`${provider} token exchange failed: ${tokenResp.status} ${await tokenResp.text()}`);
  const tokenJson = (await tokenResp.json()) as { access_token: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (tokenJson.error) throw new Error(`${provider} token exchange returned an error: ${tokenJson.error} -- ${tokenJson.error_description ?? ""}`);

  // User-Agent is a long-standing hard requirement of GitHub's own
  // REST API (a request with none is rejected outright) -- harmless
  // to send to CF/Google regardless.
  const userResp = await fetch(config.userinfoUrl, { headers: { authorization: `Bearer ${tokenJson.access_token}`, accept: "application/json", "user-agent": "zzmq-dev" } });
  if (!userResp.ok) throw new Error(`${provider} userinfo fetch failed: ${userResp.status} ${await userResp.text()}`);
  const userJson = await userResp.json();
  const { subject, email, displayName } = config.parseUserInfo(userJson);

  return { subject, email, displayName, accessToken: tokenJson.access_token, refreshToken: tokenJson.refresh_token ?? null, expiresInSeconds: tokenJson.expires_in ?? null };
}

// --- Encryption for stored OAuth tokens (AES-GCM, Web Crypto -- available natively in Workers) ---

async function importKey(env: OAuthEnv): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(required(env.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env: OAuthEnv, plaintext: string): Promise<string> {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptSecret(env: OAuthEnv, encoded: string): Promise<string> {
  const key = await importKey(env);
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

// --- Session cookie helpers ---

const SESSION_COOKIE = "zz_session";

export function sessionCookieHeader(sessionId: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v ?? null;
  }
  return null;
}

// --- Agent bearer tokens (CLI/tool auth, separate from human sessions) ---

export function generateAgentToken(): string {
  return `zzat-${randomBytes(24).toString("hex")}`;
}

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}
