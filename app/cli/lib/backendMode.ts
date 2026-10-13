// The local/remote CLI-mode choice (not to be confused with
// engine/backend.ts's own resolveBackend(), which is a different axis
// entirely -- that one picks where Lane/Ladder data for the LOCAL
// path lives; this one picks whether a command talks to a deployed
// Worker at all). Extracted out of work.ts/review.ts, which had this
// same useRemote/identity/cleanup/withBackend shape duplicated
// near-verbatim -- see each command's own remaining logic (per-repo
// clone strategy, the actual mainLoop) for what's genuinely different
// between them.
import { withBackend } from "../../engine/backend.js";
import { resolveIdentity, releaseIdentity, type ResolvedIdentity } from "./identity.js";
import { setActiveToken } from "./api.js";
import { remoteBackend } from "./remoteBackend.js";

export interface BackendModeOptions {
  /** Forces the original local/demo backend (a real local clone, state in .zz/) instead of the default: a deployed Worker's real protocol state. */
  local?: boolean;
  /** Act as a managed agent instead of yourself -- see identity.ts's resolveIdentity. Ignored in local mode (there's no remote identity to mint). */
  as?: string;
}

export interface BackendMode {
  useRemote: boolean;
  /** null in local mode, or when ZZ_ID/ZZ_ID_FILE/your own login resolves without minting anything new. */
  identity: ResolvedIdentity | null;
  /** Runs fn with the right Backend scoped in -- remoteBackend if remote (so engine/lane.ts's own readLane/listLanes calls route to the deployed Worker), the already-registered local Backend otherwise. The one shared try/withBackend shape every caller needs. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Releases an --as-minted identity, if any. Idempotent -- safe to call from both a SIGINT/SIGTERM handler and a normal finally without double-revoking. */
  cleanup(): Promise<void>;
}

export async function resolveCliBackendMode(options: BackendModeOptions): Promise<BackendMode> {
  const useRemote = !options.local;
  const identity = useRemote ? await resolveIdentity(options.as) : null;
  if (identity) setActiveToken(identity.token);

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    await releaseIdentity(identity);
  };

  return {
    useRemote,
    identity,
    run: async (fn) => (useRemote ? await withBackend(remoteBackend, fn) : await fn()),
    cleanup,
  };
}
