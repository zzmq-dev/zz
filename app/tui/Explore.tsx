// `zz top`'s "find more repos" tab -- reachable at any time via the
// normal tab navigation (see TopApp.tsx), same "track" action either
// way (top.ts's own onTrack), but a completely different interaction
// per mode: remote is a search box against the real backend; local is
// a filesystem browser, since there's no server to search against.
//
// Free-text search needs every character (including letters/digits
// TabView's own hotkeys use for tab-switch/quit/copy), so remote mode
// has an explicit edit-mode toggle ("/" to start typing, Enter to
// search and stop, Escape to cancel and stop) -- while editing,
// onEditingChange(true) tells TopApp to pass `inputPaused` down to
// TabView, suppressing its own key handling for exactly as long as
// typing is happening. Local mode never needs this: directory
// navigation (arrows/enter) and "t" to track don't collide with
// anything TabView listens for.
import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { apiFetch } from "../cli/lib/api.js";
import { isLocallyOnboarded, inferGitHubSlugFromDir, resolveRepo } from "../cli/lib/repo.js";
import { collectLadder } from "../engine/ladderRender.js";
import { listLanes } from "../engine/store.js";
import { MUTED, PINK, GREEN, YELLOW, CYAN } from "./theme.js";

interface RepoHit {
  slug: string;
  description: string | null;
}

interface RepoPreview {
  slug: string;
  description: string | null;
  ladderSummary: string | null;
  childCount: number;
  laneCount: number | null;
  error: string | null;
}

export function Explore({ local, onTrack, onEditingChange }: { local: boolean; onTrack: (slug: string) => Promise<void>; onEditingChange: (editing: boolean) => void }) {
  return local ? <LocalExplore onTrack={onTrack} /> : <RemoteExplore onTrack={onTrack} onEditingChange={onEditingChange} />;
}

/** Anonymous POST to one repo's tool-call endpoint -- allowAnonymous works here specifically because the server now allows lane_list/ladder_tree with no auth for a PUBLIC repo (see webApp.ts's ANON_READ_TOOLS); any other tool, or a private repo, would 401 same as before. */
async function callToolAnon<T>(slug: string, tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const data = await apiFetch<{ result: T }>("POST", `/api/repos/${slug}/tools/${tool}`, args, undefined, true);
  return data.result;
}

async function loadPreview(hit: RepoHit): Promise<RepoPreview> {
  try {
    const [tree, lanes] = await Promise.all([
      callToolAnon<{ summary: string; children: unknown[] } | null>(hit.slug, "ladder_tree"),
      callToolAnon<unknown[]>(hit.slug, "lane_list"),
    ]);
    return { slug: hit.slug, description: hit.description, ladderSummary: tree?.summary ?? null, childCount: tree?.children.length ?? 0, laneCount: lanes.length, error: null };
  } catch (err) {
    return { slug: hit.slug, description: hit.description, ladderSummary: null, childCount: 0, laneCount: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function RemoteExplore({ onTrack, onEditingChange }: { onTrack: (slug: string) => Promise<void>; onEditingChange: (editing: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RepoHit[]>([]);
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState("press / to search");
  const [tracked, setTracked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<RepoPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const { isRawModeSupported } = useStdin();

  useEffect(() => onEditingChange(editing), [editing, onEditingChange]);

  // Debounced search-as-you-type -- fires ~250ms after the query stops
  // changing, not on every keystroke, so a fast typist doesn't queue
  // up a dozen overlapping requests against the real backend.
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const id = setTimeout(async () => {
      setStatus("searching...");
      try {
        // allowAnonymous: this has to work with no `zz login` session
        // at all -- that's the whole point of remote Explore existing
        // (see top.ts's own header comment).
        const data = await apiFetch<{ repos: RepoHit[] }>("GET", `/api/explore/search?q=${encodeURIComponent(query)}`, undefined, undefined, true);
        if (cancelled) return;
        setResults(data.repos);
        setSelected(0);
        setStatus(data.repos.length === 0 ? "no matches" : `${data.repos.length} match${data.repos.length === 1 ? "" : "es"}`);
      } catch (err) {
        if (!cancelled) setStatus(`search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [query]);

  useInput(
    (input, key) => {
      if (editing) {
        if (key.return) {
          setEditing(false);
        } else if (key.escape) {
          setEditing(false);
        } else if (key.backspace || key.delete) {
          setQuery((q) => q.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          setQuery((q) => q + input);
        }
        return;
      }
      if (preview) {
        if (input === "t" && !tracked.has(preview.slug)) {
          setStatus(`tracking ${preview.slug}...`);
          onTrack(preview.slug)
            .then(() => {
              setTracked((t) => new Set(t).add(preview.slug));
              setStatus(`tracking ${preview.slug} -- switch to the lanes/ladder tabs to watch it`);
            })
            .catch((err) => setStatus(`track failed: ${err instanceof Error ? err.message : String(err)}`));
        } else if (key.escape || key.backspace || key.delete) {
          setPreview(null);
          setStatus("");
        }
        return;
      }
      if (input === "/") {
        setEditing(true);
      } else if (key.upArrow) {
        setSelected((s) => Math.max(0, s - 1));
      } else if (key.downArrow) {
        setSelected((s) => Math.min(results.length - 1, s + 1));
      } else if (key.return && results[selected]) {
        const hit = results[selected];
        setPreviewLoading(true);
        setStatus("");
        loadPreview(hit).then((p) => {
          setPreview(p);
          setPreviewLoading(false);
        });
      }
    },
    { isActive: isRawModeSupported },
  );

  if (previewLoading || preview) {
    return (
      <Box flexDirection="column">
        <Text bold color={PINK}>
          {preview?.slug ?? "loading..."}
        </Text>
        {previewLoading && <Text color={MUTED}>loading preview...</Text>}
        {preview && (
          <>
            {preview.description && <Text color={MUTED}>{preview.description}</Text>}
            {preview.error ? (
              <Text color={YELLOW}>couldn't load a preview: {preview.error}</Text>
            ) : (
              <Box flexDirection="column" marginTop={1}>
                <Text color={CYAN}>{preview.laneCount ?? 0} lane(s)</Text>
                <Text color={CYAN}>{preview.ladderSummary ?? "(no Ladder content yet)"}</Text>
                <Text color={MUTED}>{preview.childCount} top-level entr{preview.childCount === 1 ? "y" : "ies"} in the Ladder</Text>
              </Box>
            )}
            {tracked.has(preview.slug) && <Text color={GREEN}>✓ tracked</Text>}
          </>
        )}
        <Box marginTop={1}>
          <Text color={MUTED}>{preview && !tracked.has(preview.slug) ? "t: track   " : ""}esc/backspace: back to results</Text>
        </Box>
        {status && <Text color={MUTED}>{status}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={MUTED}>
        {editing ? <Text color={YELLOW}>search: {query}█</Text> : <>search: {query || <Text color={MUTED}>(press / to search)</Text>}</>}
      </Text>
      <Text color={MUTED}>{status}</Text>
      <Box flexDirection="column" marginTop={1}>
        {results.map((r, i) => (
          <Box key={r.slug}>
            <Text bold={i === selected} color={i === selected ? PINK : undefined}>
              {i === selected ? "> " : "  "}
              {r.slug}
            </Text>
            {tracked.has(r.slug) && <Text color={GREEN}> ✓ tracked</Text>}
            {r.description && (
              <Text color={MUTED} wrap="truncate-end">
                {" "}
                -- {r.description}
              </Text>
            )}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={MUTED}>/: search   ↑/↓: select   enter: view   (while typing: enter: search, esc: cancel)</Text>
      </Box>
    </Box>
  );
}

interface DirEntry {
  name: string;
  isGit: boolean;
}

function listDirs(dir: string): DirEntry[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, isGit: existsSync(join(dir, e.name, ".git")) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

interface LocalPreview {
  ladderSummary: string | null;
  childCount: number;
  laneCount: number;
}

function LocalExplore({ onTrack }: { onTrack: (slug: string) => Promise<void> }) {
  const [cwd, setCwd] = useState(process.cwd());
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState("");
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [preview, setPreview] = useState<LocalPreview | null>(null);
  const { isRawModeSupported } = useStdin();
  const atRoot = dirname(cwd) === cwd;
  const isGitRepo = existsSync(join(cwd, ".git"));
  const slugHere = isGitRepo ? inferGitHubSlugFromDir(cwd) : null;
  const entries = isGitRepo ? [] : listDirs(cwd);
  const items = atRoot || isGitRepo ? entries : [{ name: "..", isGit: false }, ...entries];

  useEffect(() => {
    if (!isGitRepo || !slugHere) {
      setOnboarded(null);
      setPreview(null);
      return;
    }
    let cancelled = false;
    const repo = resolveRepo(slugHere);
    isLocallyOnboarded(repo).then(async (result) => {
      if (cancelled) return;
      setOnboarded(result);
      if (!result) return;
      const [{ tree }, lanes] = await Promise.all([collectLadder(repo.repoDir, repo.stateDir), Promise.resolve(listLanes(repo.stateDir))]);
      if (!cancelled) setPreview({ ladderSummary: tree.summary, childCount: tree.children.length, laneCount: lanes.length });
    });
    return () => {
      cancelled = true;
    };
  }, [isGitRepo, slugHere]);

  useInput((input, key) => {
    if (isGitRepo) {
      if (input === "t" && slugHere && onboarded) {
        setStatus(`tracking ${slugHere}...`);
        onTrack(slugHere)
          .then(() => setStatus(`tracking ${slugHere} -- switch to the lanes/ladder tabs to watch it`))
          .catch((err) => setStatus(`track failed: ${err instanceof Error ? err.message : String(err)}`));
      } else if (key.backspace || key.delete || input === "u") {
        setCwd(dirname(cwd));
        setSelected(0);
        setStatus("");
      }
      return;
    }
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    else if (key.downArrow) setSelected((s) => Math.min(items.length - 1, s + 1));
    else if (key.return && items[selected]) {
      const item = items[selected];
      setCwd(item.name === ".." ? dirname(cwd) : join(cwd, item.name));
      setSelected(0);
      setStatus("");
    }
  }, { isActive: isRawModeSupported });

  return (
    <Box flexDirection="column">
      <Text color={CYAN}>{cwd}</Text>
      {isGitRepo ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={MUTED}>this is a git repo{slugHere ? ` (${slugHere} on GitHub)` : " (no GitHub origin remote)"}</Text>
          {slugHere ? (
            onboarded === null ? (
              <Text color={MUTED}>checking onboarding status...</Text>
            ) : onboarded ? (
              <Box flexDirection="column">
                <Text color={GREEN}>✓ onboarded -- press t to track it</Text>
                {preview && (
                  <Box flexDirection="column" marginTop={1}>
                    <Text color={CYAN}>{preview.laneCount} lane(s)</Text>
                    <Text color={CYAN}>{preview.ladderSummary ?? "(no Ladder content yet)"}</Text>
                    <Text color={MUTED}>{preview.childCount} top-level entr{preview.childCount === 1 ? "y" : "ies"} in the Ladder</Text>
                  </Box>
                )}
              </Box>
            ) : (
              <Text color={YELLOW}>not onboarded yet -- run: zz ladder build {slugHere}</Text>
            )
          ) : (
            <Text color={YELLOW}>zz ladder build needs a GitHub origin remote -- this repo doesn't have one, so there's no onboarding command to offer here.</Text>
          )}
          <Box marginTop={1}>
            <Text color={MUTED}>t: track (if onboarded)   backspace/u: up a directory</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {items.length === 0 && <Text color={MUTED}>(empty)</Text>}
          {items.map((item, i) => (
            <Box key={item.name}>
              <Text bold={i === selected} color={i === selected ? PINK : undefined}>
                {i === selected ? "> " : "  "}
                {item.name}/{item.isGit ? " [git]" : ""}
              </Text>
            </Box>
          ))}
          <Box marginTop={1}>
            <Text color={MUTED}>↑/↓: select   enter: open</Text>
          </Box>
        </Box>
      )}
      {status && <Text color={MUTED}>{status}</Text>}
    </Box>
  );
}
