// #23: a thin client for zz's own did:guardian registrar instance
// (zzmq.dev itself, as of the bare-domain move -- see
// github.com/did-method-guardian/did-method-guardian). zz calls this as
// a sibling service, not a reimplementation -- the registrar's own
// package (packages/server in that repo) owns all of the actual
// protocol logic (key custody, signing, the operation log).

const GUARDIAN_REGISTRAR_BASE = "https://zzmq.dev";

export interface GuardianFetchEnv {
  GUARDIAN_SERVER?: Fetcher;
}

/**
 * A plain fetch() from zz-maintainer to https://zzmq.dev/... -- the
 * registrar's own routes, same zone, a different Worker -- reliably 522s in
 * production: confirmed live, a known Workers gotcha where a same-zone
 * subrequest can deadlock against the zone's own edge routing, not
 * something either Worker's own code is doing wrong. A service binding
 * calls the other Worker directly, in-process, bypassing the public edge
 * entirely -- the fix, not a workaround, for exactly this one case. Falls
 * back to a plain fetch if the binding isn't configured (e.g. local dev
 * without it wired up), same request either way.
 */
function guardianFetch(env: GuardianFetchEnv, path: string, init?: RequestInit): Promise<Response> {
  const url = `${GUARDIAN_REGISTRAR_BASE}${path}`;
  return env.GUARDIAN_SERVER ? env.GUARDIAN_SERVER.fetch(url, init) : fetch(url, init);
}

/**
 * did:guardian names are ABNF-constrained to 3-32 lowercase alphanumeric/
 * hyphen characters. zz's own usernames don't fit that at all: a human's is
 * their real email address (`@`, `.`, no length cap); a managed agent's is
 * `${creator}[${name}]`, which inherits the creator's own email plus `[`/`]`
 * and routinely blows past 32 characters once nested a level or two.
 *
 * Rather than a lossy character substitution (tried first, found live: it
 * still left `@`/`.` in place for anything created by a human, and did
 * nothing about the length cap -- confirmed by a real failed registration,
 * not a hypothetical), this hashes the full username deterministically.
 * Preserves global uniqueness (SHA-256 collisions aren't a practical
 * concern here) and satisfies the DID's own syntax unconditionally,
 * independent of whatever zz's own username shape does next. Costs
 * readability -- the did:guardian name won't visually resemble the zz
 * username -- but nothing about this scheme was relying on that; a zz
 * username is still the human-facing identity either way.
 */
export async function didSafeName(username: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(username));
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `z${hex.slice(0, 24)}`;
}

export interface GuardianRegistration {
  did: string;
  login_secret: string;
}

/**
 * Registers a new, ownerless did:guardian identity for `username`. Best-
 * effort: never throws -- a brief outage on the registrar's own side should
 * never block zz's own agent-creation flow, which is the actual load-bearing
 * operation here. Returns null (logged, not thrown) on any failure.
 */
export async function registerGuardianIdentity(env: GuardianFetchEnv, username: string): Promise<GuardianRegistration | null> {
  try {
    const resp = await guardianFetch(env, "/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: await didSafeName(username) }),
    });
    if (!resp.ok) {
      console.error(`guardianClient: registration failed for "${username}": ${resp.status} ${await resp.text()}`);
      return null;
    }
    const body = (await resp.json()) as { did: string; login_secret: string };
    return { did: body.did, login_secret: body.login_secret };
  } catch (e) {
    console.error(`guardianClient: registration request failed for "${username}":`, e);
    return null;
  }
}

export type RegisterNameResult = { ok: true; did: string; login_secret: string } | { ok: false; status: number; message: string };

/**
 * Registers a human-chosen name, unmodified -- the interactive name-
 * picker's own call (the login redesign). Unlike registerGuardianIdentity
 * above, this is NOT best-effort: the picker flow doesn't complete until a
 * real name is registered, so a failure has to be shown to the person, not
 * swallowed. Distinguishes the registrar's documented 409 ("name already
 * taken") from any other failure so the picker can say exactly that, not a
 * generic error.
 */
export async function registerGuardianName(env: GuardianFetchEnv, name: string): Promise<RegisterNameResult> {
  try {
    const resp = await guardianFetch(env, "/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!resp.ok) {
      const body = (await resp.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, status: resp.status, message: body?.error ?? `registration failed (${resp.status})` };
    }
    const body = (await resp.json()) as { did: string; login_secret: string };
    return { ok: true, did: body.did, login_secret: body.login_secret };
  } catch (e) {
    return { ok: false, status: 0, message: `couldn't reach the registrar: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Client-side pre-check mirroring the registrar's own name ABNF (packages/server/src/registrar.ts's NAME_RE) -- UX sugar only, the registrar stays authoritative. */
export const GUARDIAN_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

/**
 * Wires a contact email for a just-created identity, right after
 * registration -- before any interactive session with the registrar
 * exists, which is exactly why this needs zz's own trusted-client
 * credential (the same one used for OIDC, see clientAuth.ts on the
 * registrar's own side) rather than the ward's own session cookie.
 * Best-effort: never blocks the name-picker's own success on a transient
 * failure here -- a contact email can always be set up later from
 * profile settings, same registrar endpoint, same verification-link flow.
 */
export async function setGuardianContactEmail(env: GuardianFetchEnv & { GUARDIAN_OIDC_CLIENT_ID?: string; GUARDIAN_OIDC_CLIENT_SECRET?: string }, name: string, forwardTo: string): Promise<void> {
  if (!env.GUARDIAN_OIDC_CLIENT_ID || !env.GUARDIAN_OIDC_CLIENT_SECRET) return;
  try {
    const basic = btoa(`${env.GUARDIAN_OIDC_CLIENT_ID}:${env.GUARDIAN_OIDC_CLIENT_SECRET}`);
    const resp = await guardianFetch(env, `/.well-known/guardian/${name}/email`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${basic}` },
      body: JSON.stringify({ forward_to: forwardTo }),
    });
    if (!resp.ok) console.error(`guardianClient: contact email setup failed for "${name}": ${resp.status} ${await resp.text()}`);
  } catch (e) {
    console.error(`guardianClient: contact email setup request failed for "${name}":`, e);
  }
}
