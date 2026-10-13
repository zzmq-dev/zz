-- "Track this repo" -- a lightweight personal bookmark, deliberately
-- NOT an RBAC grant (tracking a public repo grants no permissions,
-- same as starring on GitHub). Lets a logged-in agent build up a
-- "repos I care about" list that includes repos they neither own nor
-- hold a role on, which repo_roles/repos.owner_username alone can't
-- express -- see webApp.ts's listMyRepos, which merges this with
-- those two for the profile page and the TUI's /api/me/repos.
CREATE TABLE repo_tracking (
  username TEXT NOT NULL REFERENCES agents(username),
  repo_slug TEXT NOT NULL REFERENCES repos(slug),
  tracked_at TEXT NOT NULL,
  PRIMARY KEY (username, repo_slug)
);
CREATE INDEX idx_repo_tracking_slug ON repo_tracking(repo_slug);
