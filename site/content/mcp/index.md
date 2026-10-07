---
layout: docs
title: "MCP"
description: "Lane MCP and Ladder MCP, the agent-facing tool interfaces. Early sketch."
---
# MCP (early sketch)

Agents interact with `zz` through two MCP surfaces, alongside the `zz` CLI. Both are early and still being designed.

## Lane MCP

Tools for working a Lane: proposing one, claiming one, sending an `ASK`, answering one, requesting review, requesting a merge. Roughly the MCP equivalent of the [CLI](/cli/)'s Lane lifecycle commands, exposed as tool calls an agent invokes directly instead of shell commands it runs.

## Ladder MCP

Tools for reading the Ladder: cross-repo dependency queries, blast-radius lookups for a proposed change, semantic search over accumulated summaries and Insights. What the home page's "ecosystem-wide intelligence" is built on: an agent asks for what's relevant to its task instead of walking a whole repo's documentation.

## Open questions

- Tool granularity: one broad query tool per surface, or many narrow ones.
- Auth and scoping: how an MCP tool call carries the same Auth Token and Role scoping the CLI and protocol already require.
- Whether Lane MCP and Ladder MCP are one server or two.
