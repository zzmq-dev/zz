-- A D1 cache of Lane metadata, kept in sync from MaintainerDO.callTool
-- (the one real chokepoint every lane_propose/lane_grant/lane_revoke
-- passes through, whether the caller is the web app, the CLI, or the
-- TUI) -- the actual Lane lives per-repo inside that repo's own
-- coordinator Durable Object; there is no existing way to search or
-- browse Lanes across repos without fanning out to every single
-- repo's DO. This table exists so Explore and the profile page can
-- query/search Lanes directly, the same way repos.* already lets them
-- query/search repos today.
--
-- Mirrors repo_roles' own flat shape (one row per principal+role)
-- rather than a JSON column, for the same reason: "lanes I coordinate"
-- becomes a plain indexed WHERE, no JSON parsing needed anywhere this
-- is read.
CREATE TABLE lanes (
  repo_slug TEXT NOT NULL REFERENCES repos(slug),
  lane_id TEXT NOT NULL,
  name TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  origin_repo_slug TEXT,
  origin_lane_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_slug, lane_id)
);
CREATE INDEX idx_lanes_origin ON lanes(origin_repo_slug, origin_lane_id);
CREATE INDEX idx_lanes_updated ON lanes(updated_at);

-- No FK on `principal` -- same as repo_roles, deliberately: this is a
-- derived cache, never the source of truth, so a sync must never fail
-- the real operation that already succeeded just because some
-- principal string doesn't (yet, or ever) correspond to a registered
-- agents row.
CREATE TABLE lane_principals (
  repo_slug TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'coordinator', 'viewer', 'committee')),
  PRIMARY KEY (repo_slug, lane_id, principal, role),
  FOREIGN KEY (repo_slug, lane_id) REFERENCES lanes(repo_slug, lane_id)
);
CREATE INDEX idx_lane_principals_principal ON lane_principals(principal);
