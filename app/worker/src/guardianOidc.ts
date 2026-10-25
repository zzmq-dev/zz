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

const BARE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/i;
const IDENTIFIER_RE = /^([a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?)?@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/i;

/**
 * "alice@acme.com" (named) or bare "@acme.com" (that domain's own root
 * identity) routes to whichever domain was actually given -- that
 * domain's own authority, never assumed to be zzmq.dev just because
 * it's missing a name part. A bare "alice", with no "@" at all, is
 * different: zz IS zzmq.dev's own registrar, so a plain name with no
 * domain is unambiguously one of zz's own ids -- short for
 * "alice@zzmq.dev", not a parse failure. Typing "@zzmq.dev" or
 * "alice@zzmq.dev" explicitly still works exactly the same either way.
 */
export function parseGuardianIdentifier(input: string): GuardianIdentifier | null {
  const trimmed = input.trim();
  if (!trimmed.includes("@")) {
    return BARE_NAME_RE.test(trimmed) ? { name: trimmed.toLowerCase(), domain: "zzmq.dev" } : null;
  }
  const m = trimmed.match(IDENTIFIER_RE);
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

export async function buildGuardianAuthorizeUrl(
  env: GuardianCredentialEnv & GuardianFetchEnv,
  domain: string,
  redirectUri: string,
  state: string,
  loginHint?: string | null,
): Promise<GuardianAuthorizeResult> {
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
  // Standard OIDC authentication request parameter -- we already parsed
  // "name@domain" on our own login page, so pass just the name along
  // rather than making the registrar's own login form ask the person
  // to type the same thing again in a different shape (confirmed live
  // this was a real point of confusion).
  if (loginHint) url.searchParams.set("login_hint", loginHint);
  return { ok: true, url: url.toString() };
}

export interface GuardianIdentity {
  did: string; // the verified sub claim -- the full did:guardian:... string
}

/**
 * The current guardian set for a did:guardian identity, local or foreign --
 * not exposed as a convenience field on the DID Document itself (method-
 * internal state, per the spec), but derivable from data that's already
 * fully public regardless: the operation log (GET .../log), which already
 * carries every guardian-affecting op's own content in plain. This is a
 * plain reducer over that log, not a new disclosure -- no cryptographic
 * verification needed for this read-only check, the same trust zz already
 * extends to its own registrar calls elsewhere. Needed for `zz work --as`'s
 * own live guardian check (formal spec REQ-4-2: a live reference, never a
 * cached snapshot).
 *
 * did:guardian v0.2 replaced the single `guardian_transfer` op with
 * `guardian_add`/`guardian_remove`, and genesis
 * now always starts guardian-less -- a brand-new managed identity's own log
 * is `custodial_create` (incoming always []) immediately followed by a
 * `guardian_add` naming its real guardian, not a single op carrying it
 * directly the way it used to. `guardian_transfer` is still handled, for
 * any already-accepted history predating that change, never produced by a
 * registrar for a new registration going forward.
 *
 * Known limitation, shared with this function's own pre-v0.2 shape: a
 * nullified branch (REQ-6-8 through REQ-6-11) is not detected here -- a
 * plain linear scan, not the chain-reconstruction-aware replay
 * @did-guardian/lib's own document.ts does. A guardian_add/guardian_remove
 * that happened to fall on a branch a later recovery rotation superseded
 * would be counted here when it shouldn't be. Rare (nullification is an
 * infrequent guardian-initiated recovery path, not ordinary operation), and
 * not introduced by this fix -- worth revisiting if/when zz depends on
 * @did-guardian/lib directly rather than re-deriving this independently.
 */
export async function currentGuardians(env: GuardianFetchEnv, name: string | null, domain: string): Promise<string[] | null> {
  try {
    const path = `/.well-known/guardian/${name ?? "_"}/log`;
    const resp = await guardianFetch(env, `https://${domain}${path}`);
    if (!resp.ok) return null;
    const log = (await resp.json()) as { op: { type: string; incoming?: string | string[]; outgoing?: string } }[];
    let guardians: string[] = [];
    for (const entry of log) {
      const op = entry.op;
      if (op.type === "custodial_create" || op.type === "guardian_transfer") guardians = (op.incoming as string[] | undefined) ?? [];
      else if (op.type === "guardian_add" && op.incoming) guardians = [...guardians, op.incoming as string];
      else if (op.type === "guardian_remove" && op.outgoing) guardians = guardians.filter((d) => d !== op.outgoing);
      else if (op.type === "guardian_relinquish") guardians = [];
    }
    return guardians;
  } catch {
    return null;
  }
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
