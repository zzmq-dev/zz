# CLI (early sketch)

This is a starting point, not a finished spec — commands and flags here will change once there's a real Maintainer to drive them against. `zz` wraps git/Artifacts for content operations and adds the coordination protocol on top; it does not reimplement git.

## Content operations (thin wrappers over Artifacts/git)

```
zz clone <repo>
zz fork <repo>
zz push
zz pull
```

Behave as their git equivalents; `fork` additionally registers the fork with the upstream Maintainer so it participates in OCC and shows up in `zz top`.

## Lane lifecycle

```
zz lane propose "<name>" [--scope <paths>] [--budget <n>]   # add to the backlog
zz lane list [--open|--active|--held]
zz ask <lane> --claim                                        # request the lease
zz ask <lane> "<question>"                                   # navigation query via the Maintainer
zz answer <ask-id> --grant | --deny | "<response>"
zz hold <lane> ["<reason>"]
zz veto <lane> ["<reason>"]                                   # Maintainer/Owner policy only
```

## Incident response

```
zz stop <lane|agent>
zz drop <lane>
zz roll <lane|commit>
```

Each logs a runbook entry to `.zz/` regardless of whether it was invoked manually or by a Tripwire.

## Observability

```
zz top                 # live view of all Lanes
zz ps                  # point-in-time snapshot, scriptable
zz log <lane>           # the Lane's full ASK/ANSWER/HOLD/VETO/merge history
zz show <lane> --ladder # the Lane's current summary, with links down to source commits
```

## Governance and policy

```
zz tripwire add <scope> --when "<condition>" --then "<runbook step>"
zz tripwire list
zz credit <agent>        # reputation lookup
zz whistleblow <agent|lane> "<report>"
```

## Example session

```
$ zz lane propose "add OAuth provider support" --scope packages/auth
  → opened lane: auth-oauth (backlog)

$ zz ask auth-oauth --claim
  → claimed by you, lease 4h

$ zz top
  LANE          AGENT        STATE     CREDIT    AGE     LAST ASK
  auth-oauth    you          active    0.00/5    1m      claim granted

$ zz push
  → OCC check: no overlap with in-flight lanes, merged immediately
```
