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

export type RegisterNameResult = { ok: true; did: string; login_secret: string } | { ok: false; status: number; message: string };

/**
 * Registers a human-chosen name, unmodified -- the interactive name-
 * picker's own call (the login redesign). NOT best-effort: the picker
 * flow doesn't complete until a real name is registered, so a failure
 * has to be shown to the person, not swallowed. Distinguishes the
 * registrar's documented 409 ("name already taken") from any other
 * failure so the picker can say exactly that, not a generic error.
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

export type RegisterManagedResult = { ok: true; did: string; name: string; login_secret: string } | { ok: false; message: string };

/**
 * `zz work --register`: a brand-new managed identity, the caller's own
 * guardian_did as its real, signed guardian from day one (the atomic
 * registrar capability, authenticated the same way as setGuardianContactEmail
 * above). `seedName` is a proposed name, negotiated for uniqueness here
 * (auto-suffixed on a 409, same pattern as accountsDb.ts's own
 * uniqueUsername) rather than failing outright on the first collision --
 * omitted, a random candidate is generated the same way. Bounded to 20
 * attempts; a 409 storm that long is not a real-world case this needs to
 * handle gracefully, just not hang forever on.
 */
export async function registerManagedGuardianIdentity(
  env: GuardianFetchEnv & { GUARDIAN_OIDC_CLIENT_ID?: string; GUARDIAN_OIDC_CLIENT_SECRET?: string },
  guardianDid: string,
  seedName?: string,
): Promise<RegisterManagedResult> {
  if (!env.GUARDIAN_OIDC_CLIENT_ID || !env.GUARDIAN_OIDC_CLIENT_SECRET) {
    return { ok: false, message: "zz's own registrar client credential isn't configured" };
  }
  const basic = btoa(`${env.GUARDIAN_OIDC_CLIENT_ID}:${env.GUARDIAN_OIDC_CLIENT_SECRET}`);
  // Slugify a given seed rather than discarding it outright the moment it
  // isn't already did:guardian-name-shaped (spaces, capitals, punctuation
  // are all a normal thing to type as a display name) -- "Claude Code"
  // should become the candidate "claude-code", not silently fall through
  // to a random one just because it wasn't typed pre-sanitized.
  const slugified = seedName
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const base = slugified && GUARDIAN_NAME_RE.test(slugified) ? slugified : `agent-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  let candidate = base;
  for (let attempt = 0, n = 2; attempt < 20; attempt++) {
    try {
      const resp = await guardianFetch(env, "/register", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Basic ${basic}` },
        body: JSON.stringify({ name: candidate, guardian_did: guardianDid }),
      });
      if (resp.status === 409) {
        candidate = `${base}-${n}`;
        n++;
        continue;
      }
      if (!resp.ok) {
        const body = (await resp.json().catch(() => null)) as { error?: string } | null;
        return { ok: false, message: body?.error ?? `registration failed (${resp.status})` };
      }
      const body = (await resp.json()) as { did: string; login_secret: string };
      return { ok: true, did: body.did, name: candidate, login_secret: body.login_secret };
    } catch (e) {
      return { ok: false, message: `couldn't reach the registrar: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { ok: false, message: `couldn't find a free name starting from "${base}" after 20 attempts` };
}

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
export type ReissueLoginSecretResult = { ok: true; login_secret: string } | { ok: false; message: string };

/**
 * Regenerates an agent's own did:guardian login secret -- the one real
 * recovery path for "I never saved it" or "I think it leaked." Same
 * trusted-client credential as setGuardianContactEmail above (the person
 * is already authenticated to zz's own session, not to this registrar
 * directly), and the registrar's own endpoint invalidates the old secret
 * the instant this succeeds -- never best-effort, a failure here has to
 * reach the person asking for it, not be swallowed.
 */
export async function reissueGuardianLoginSecret(env: GuardianFetchEnv & { GUARDIAN_OIDC_CLIENT_ID?: string; GUARDIAN_OIDC_CLIENT_SECRET?: string }, name: string): Promise<ReissueLoginSecretResult> {
  if (!env.GUARDIAN_OIDC_CLIENT_ID || !env.GUARDIAN_OIDC_CLIENT_SECRET) {
    return { ok: false, message: "zz's own registrar client credential isn't configured" };
  }
  try {
    const basic = btoa(`${env.GUARDIAN_OIDC_CLIENT_ID}:${env.GUARDIAN_OIDC_CLIENT_SECRET}`);
    const resp = await guardianFetch(env, `/.well-known/guardian/${name}/login-secret`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}` },
    });
    if (!resp.ok) {
      const body = (await resp.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, message: body?.error ?? `reissue failed (${resp.status})` };
    }
    const body = (await resp.json()) as { login_secret: string };
    return { ok: true, login_secret: body.login_secret };
  } catch (e) {
    return { ok: false, message: `couldn't reach the registrar: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export type RotateGuardianKeyResult = { ok: true; document: unknown } | { ok: false; message: string };

/**
 * Rotates an agent's own custodied did:guardian operational key (the
 * real cryptographic identity key, not the login_secret above -- a
 * completely different credential, see registrar.ts's own rotateWard
 * for why this has to be a registrar capability at all). Same trusted-
 * client credential as reissueGuardianLoginSecret: zz's own backend has
 * already decided the caller is allowed to do this for `name` (itself,
 * or a managed agent it created -- same bar as minting that agent a
 * new token, requireTokenMintAuthority) before this is ever called.
 */
export async function rotateGuardianKey(env: GuardianFetchEnv & { GUARDIAN_OIDC_CLIENT_ID?: string; GUARDIAN_OIDC_CLIENT_SECRET?: string }, name: string): Promise<RotateGuardianKeyResult> {
  if (!env.GUARDIAN_OIDC_CLIENT_ID || !env.GUARDIAN_OIDC_CLIENT_SECRET) {
    return { ok: false, message: "zz's own registrar client credential isn't configured" };
  }
  try {
    const basic = btoa(`${env.GUARDIAN_OIDC_CLIENT_ID}:${env.GUARDIAN_OIDC_CLIENT_SECRET}`);
    const resp = await guardianFetch(env, `/.well-known/guardian/${name}/rotate`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}` },
    });
    if (!resp.ok) {
      const body = (await resp.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, message: body?.error ?? `rotation failed (${resp.status})` };
    }
    const body = (await resp.json()) as { document: unknown };
    return { ok: true, document: body.document };
  } catch (e) {
    return { ok: false, message: `couldn't reach the registrar: ${e instanceof Error ? e.message : String(e)}` };
  }
}

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
