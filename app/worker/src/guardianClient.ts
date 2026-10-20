// #23: a thin client for zz's own did:guardian registrar instance
// (id.zzmq.dev, github.com/did-method-guardian/did-method-guardian).
// zz calls this as a sibling service, not a reimplementation -- the
// registrar's own package (packages/server in that repo) owns all of
// the actual protocol logic (key custody, signing, the operation log).

const GUARDIAN_REGISTRAR_BASE = "https://id.zzmq.dev";

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
export async function registerGuardianIdentity(username: string): Promise<GuardianRegistration | null> {
  try {
    const resp = await fetch(`${GUARDIAN_REGISTRAR_BASE}/register`, {
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
