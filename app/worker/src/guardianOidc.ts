// Federated "Sign in with did:guardian" OIDC client.
//
// Generalized to any registrar via its own /.well-known/openid-
// configuration, not hardcoded to zzmq.dev -- a relying party asks for
// a name@domain identifier, discovers that domain's own endpoints, and
// proceeds with an ordinary OIDC authorization-code flow against them.
// zz is a confidential client (holds a client_secret) wherever it has
// one, so this never needs PKCE.
//
// zz only holds a pre-registered client credential for an explicit,
// small set of domains (see credentialFor below) -- federating to any
// OTHER registrar requires that operator to have manually pre-
// registered zz as an OIDC client there first (did:guardian's own OIDC
// layer has no dynamic/self-service client registration, a deliberate
// v1 decision, not an oversight). Attempting login against a domain zz
// holds no credential for fails with a clear, zz-rendered message
// before any redirect -- never bouncing the user into a foreign
// domain's own raw OIDC error page.

export interface GuardianIdentifier {
  name: string | null; // null for a bare-domain identity ("@acme.com")
  domain: string;
}

const IDENTIFIER_RE = /^([a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?)?@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/i;

/** "alice@acme.com" (named) or bare "@acme.com" (that domain's own root identity) -- the same email-shaped input this login option has always meant, now routing to whichever domain was actually given instead of always zzmq.dev. */
export function parseGuardianIdentifier(input: string): GuardianIdentifier | null {
  const m = input.trim().match(IDENTIFIER_RE);
  if (!m) return null;
  return { name: m[1] ? m[1].toLowerCase() : null, domain: m[2].toLowerCase() };
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

export interface GuardianFetchEnv {
  // A plain fetch() from zz-maintainer back to https://zzmq.dev/... (same
  // zone, a different Worker) reliably 522s in production -- confirmed
  // live, a known Workers gotcha, not an error in either Worker's own
  // code. A service binding calls it directly, in-process, bypassing the
  // public edge -- used only for zz's own zzmq.dev instance; a genuinely
  // external registrar always goes over a plain fetch, same as any other
  // domain this Worker doesn't itself operate.
  GUARDIAN_SERVER?: Fetcher;
}

function guardianFetch(env: GuardianFetchEnv, url: string, init?: RequestInit): Promise<Response> {
  return new URL(url).hostname === "zzmq.dev" && env.GUARDIAN_SERVER ? env.GUARDIAN_SERVER.fetch(url, init) : fetch(url, init);
}

async function discover(env: GuardianFetchEnv, domain: string): Promise<Discovery | null> {
  try {
    const resp = await guardianFetch(env, `https://${domain}/.well-known/openid-configuration`);
    if (!resp.ok) return null;
    const doc = (await resp.json()) as Partial<Discovery>;
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) return null;
    return doc as Discovery;
  } catch {
    return null;
  }
}

export interface GuardianCredential {
  clientId: string;
  clientSecret: string;
}

export interface GuardianCredentialEnv {
  GUARDIAN_OIDC_CLIENT_ID?: string;
  GUARDIAN_OIDC_CLIENT_SECRET?: string;
}

/** zz's own pre-registered OIDC client credential for a given registrar domain, or null if zz holds none there -- see this file's own header for why that's a clear failure, not a fallback attempt. */
export function credentialFor(env: GuardianCredentialEnv, domain: string): GuardianCredential | null {
  // zzmq.dev is zz's own instance -- the only domain with a credential
  // today. A second real entry (another operator who has manually
  // pre-registered zz) is a case to add here when it actually exists,
  // not a lookup structure to build speculatively ahead of one.
  if (domain === "zzmq.dev" && env.GUARDIAN_OIDC_CLIENT_ID && env.GUARDIAN_OIDC_CLIENT_SECRET) {
    return { clientId: env.GUARDIAN_OIDC_CLIENT_ID, clientSecret: env.GUARDIAN_OIDC_CLIENT_SECRET };
  }
  return null;
}

export type GuardianAuthorizeResult = { ok: true; url: string } | { ok: false; reason: string };

export async function buildGuardianAuthorizeUrl(env: GuardianCredentialEnv & GuardianFetchEnv, domain: string, redirectUri: string, state: string): Promise<GuardianAuthorizeResult> {
  const credential = credentialFor(env, domain);
  if (!credential) return { ok: false, reason: `zz isn't a registered sign-in client for "${domain}" yet -- its operator would need to add zz as one first.` };
  const discovery = await discover(env, domain);
  if (!discovery) return { ok: false, reason: `couldn't reach a did:guardian registrar at "${domain}".` };
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("client_id", credential.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid");
  url.searchParams.set("state", state);
  return { ok: true, url: url.toString() };
}

export interface GuardianIdentity {
  did: string; // the verified sub claim -- the full did:guardian:... string
}

export async function exchangeGuardianCode(env: GuardianCredentialEnv & GuardianFetchEnv, domain: string, code: string, redirectUri: string): Promise<GuardianIdentity | null> {
  const credential = credentialFor(env, domain);
  if (!credential) return null;
  const discovery = await discover(env, domain);
  if (!discovery) return null;
  const basic = btoa(`${credential.clientId}:${credential.clientSecret}`);
  const tokenResp = await guardianFetch(env, discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: credential.clientId, client_secret: credential.clientSecret }),
  });
  if (!tokenResp.ok) return null;
  const tokenJson = (await tokenResp.json()) as { access_token?: string };
  if (!tokenJson.access_token) return null;
  const userResp = await guardianFetch(env, discovery.userinfo_endpoint, { headers: { authorization: `Bearer ${tokenJson.access_token}` } });
  if (!userResp.ok) return null;
  const userJson = (await userResp.json()) as { sub?: string };
  if (!userJson.sub) return null;
  return { did: userJson.sub };
}
