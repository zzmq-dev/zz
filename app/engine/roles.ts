// Static Role enforcement only (see governance.md). Trust/reputation scoring
// is explicitly cut from this build (competition-plan.md); this is just
// "does this Agent hold a Role that permits this action," nothing dynamic.
import type { AgentRoles, Role } from "./types.js";

const RANK: Record<Role, number> = {
  reader: 0,
  contributor: 1,
  committer: 2,
  coordinator: 3,
  owner: 4,
};

/** Highest role this Agent holds over a given scope (path prefix), or "reader" if none granted. */
export function roleFor(agentRoles: AgentRoles | null, scope: string): Role {
  if (!agentRoles) return "reader";
  let best: Role = "reader";
  for (const grant of agentRoles.grants) {
    if (scope === grant.scope || scope.startsWith(grant.scope)) {
      if (RANK[grant.role] > RANK[best]) best = grant.role;
    }
  }
  return best;
}

export function atLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

export class RoleError extends Error {
  constructor(agent: string, action: string, required: Role) {
    super(`${agent} cannot ${action}: requires at least "${required}"`);
  }
}

export function requireRole(agentRoles: AgentRoles | null, agent: string, scope: string, minimum: Role, action: string): void {
  const role = roleFor(agentRoles, scope);
  if (!atLeast(role, minimum)) {
    throw new RoleError(agent, action, minimum);
  }
}
