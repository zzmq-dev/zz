// Resolves "who is this remote command acting as, and what credential
// does it send" -- one place, used by `zz work`/`zz review`/
// `zz repo submit`, in priority order:
//
//  1. ZZ_ID="<username>:<token>" -- for automated/headless contexts
//     with no interactive `zz login` session at all (a CI runner, a
//     container with no ~/.zz). A real, standing credential someone
//     else is managing the lifecycle of -- never minted or revoked
//     here.
//  2. ZZ_ID_FILE=<path to a file with that same "<username>:<token>"
//     text> -- the same thing, out of an env var (visible in `ps`,
//     shell history, some CI log capture) and into a file instead.
//  3. --register [name]: mints a brand-new did:guardian identity on
//     zzmq.dev, your own login as its real, signed guardian from day
//     one (not the ownerless registration a bare human signup gets)
//     -- immediately usable for this run.
//  4. --as <name-or-name@domain>: the id of the actor you want this
//     run to act as -- "the id you have guardian access to," not a
//     status category of its own (it isn't "your agent" in any
//     special sense; the same name could be anyone's). Resolves
//     against zzmq.dev by default, or any other registrar given
//     "name@domain" -- works if your own login is currently a real,
//     signed guardian of it (checked live, never cached), fails
//     clearly otherwise. A FRESH token is minted for it right now,
//     and the caller is expected to revoke it when the session ends
//     (releaseIdentity below), so nothing long-lived sits on disk.
//     This is NOT impersonation in the sense of acting without
//     consent -- it's exactly the guardian mechanism the did:guardian
//     method defines, exercised through zz rather than worked around.
//  5. No --as/--register: your own `zz login` session, directly
//     (long-lived, untouched -- never minted or revoked here).
import { readFileSync } from "node:fs";
import { apiBase, requireCredentials } from "./credentials.js";
import { apiFetch } from "./api.js";
import { resolveUserPath } from "./paths.js";

export interface ResolvedIdentity {
  apiBase: string;
  token: string;
  username: string;
  /** True only for a token minted by resolveIdentity itself (the --as/--register path) -- the one case the caller should revoke on exit (see releaseIdentity). Your own login (ZZ_ID included) is a standing credential someone else manages; never revoked here. */
  ephemeral: boolean;
}

/**
 * #26: splits on the LAST colon, not the first -- a username is now a
 * literal did:guardian string, which always contains at least one colon
 * of its own ("did:guardian:alice:zzmq.dev"); only the token after it is
 * guaranteed colon-free (zzat-<hex>, see auth.ts's generateAgentToken),
 * so the last colon is the only reliably correct split point.
 */
function parseIdPair(raw: string, source: string): { username: string; token: string } {
  const idx = raw.lastIndexOf(":");
  if (idx === -1) throw new Error(`${source} must be "<username>:<token>", got "${raw}"`);
  return { username: raw.slice(0, idx).trim(), token: raw.slice(idx + 1).trim() };
}

export interface ResolveIdentityOpts {
  as?: string;
  register?: string | boolean; // true (no name given) or the proposed name
}

export async function resolveIdentity(opts: ResolveIdentityOpts = {}): Promise<ResolvedIdentity> {
  if (process.env.ZZ_ID) {
    const { username, token } = parseIdPair(process.env.ZZ_ID, "ZZ_ID");
    return { apiBase: apiBase(), token, username, ephemeral: false };
  }
  if (process.env.ZZ_ID_FILE) {
    const raw = readFileSync(resolveUserPath(process.env.ZZ_ID_FILE), "utf8").trim();
    const { username, token } = parseIdPair(raw, "ZZ_ID_FILE");
    return { apiBase: apiBase(), token, username, ephemeral: false };
  }

  const human = requireCredentials();

  if (opts.register !== undefined) {
    const name = typeof opts.register === "string" ? opts.register : undefined;
    const { agent, token } = await apiFetch<{ agent: { username: string }; token: string }>(
      "POST",
      "/api/me/managed-identity/register",
      { name },
      human.token,
    );
    return { apiBase: human.apiBase, token, username: agent.username, ephemeral: true };
  }

  if (!opts.as) return { apiBase: human.apiBase, token: human.token, username: human.username, ephemeral: false };

  const { agent, token } = await apiFetch<{ agent: { username: string }; token: string }>(
    "POST",
    "/api/me/managed-identity/resolve",
    { identifier: opts.as },
    human.token,
  );
  return { apiBase: human.apiBase, token, username: agent.username, ephemeral: true };
}

/** Best-effort cleanup for an ephemeral (--as) identity -- revokes the token it minted, using that same token (the server's self-revoke endpoint needs no id, just the bearer presenting it). A no-op for anything resolveIdentity didn't itself mint. Swallows errors: called from exit paths (Ctrl+C, SIGTERM, a thrown error), where a failed revoke shouldn't block the process from actually exiting -- a short-lived leaked token is a minor, bounded exposure, not worth hanging the CLI over. */
export async function releaseIdentity(identity: ResolvedIdentity | null): Promise<void> {
  if (!identity?.ephemeral) return;
  try {
    await apiFetch("POST", "/api/me/revoke", undefined, identity.token);
  } catch {
    // best-effort
  }
}

/**
 * Expands a bare name (or "name@domain") given as a committee member/
 * principal into its full did:guardian id, so a `--committee`/grant
 * list can be given as plain names instead of spelling out the full id
 * for each one. #26: a bare name is no longer "a managed agent chained
 * off whoever's running the command" -- did:guardian names are scoped
 * per *registrar*, not per creator, so "alice" always means
 * did:guardian:zzmq.dev:alice, regardless of who's asking. A pure,
 * offline string construction (same shape `parseGuardianIdentifier`
 * builds server-side) -- no guardian/permission check here, this is
 * only naming who's on a committee, not authorizing anything by itself.
 * A value that's already a full "did:guardian:..." string passes
 * through unchanged. Domain-first (did:guardian:<domain>:<name>),
 * matching did:guardian's own current convention -- the "name@domain"
 * shorthand input stays name-first, a separate, deliberate convention.
 */
export function expandAgentId(raw: string): string {
  if (raw.startsWith("did:guardian:")) return raw;
  const at = raw.indexOf("@");
  if (at === -1) return `did:guardian:zzmq.dev:${raw}`;
  const name = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  return name ? `did:guardian:${domain}:${name}` : `did:guardian:${domain}`;
}
