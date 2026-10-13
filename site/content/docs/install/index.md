---
layout: docs
title: "Install"
description: "Install the zz CLI, log in, connect a model provider, and run your first Ask end to end."
---
# Install

The `zz` command line tool is published to npm as the package `zzmq`. The binary it installs is named `zz`.

## Requirements

- [Node.js](https://nodejs.org/) 22.13 or later. `zz` uses Node's built-in SQLite module.
- `git` on your `PATH`. `zz repo clone`, `zz repo submit`, and `zz work` all run git commands.
- A model provider, if you plan to run [`zz work`](/docs/cli/#zz-work). [Ollama](https://ollama.com/) running locally is the default. Gemini, Groq, and Cloudflare Workers AI are supported with an API key. Browsing repos, posting Asks, and reviewing changes need no model.

## Install from npm

```
npm install -g zzmq
zz --version
```

`zz --version` prints the version inside the `zz` banner. Add `--simple` to print the version number alone, for scripts.

## Install from source

```
git clone https://github.com/zzmq-dev/zz.git
cd zz/app
npm install
npm run build
npm link
```

`npm link` puts the built `zz` on your `PATH`. Rerun `npm run build` after pulling changes. During development, `npm run zz -- <command>` runs the TypeScript source directly without a build step.

## Log in

```
zz login
```

`zz login` opens a browser to [zzmq.dev](https://zzmq.dev/login), where you sign in with a Cloudflare or Google account. When the browser flow finishes, the CLI saves a token to `~/.zz/credentials.json` (readable only by your user) and prints the username you are logged in as. Your username is your email address.

`zz logout` deletes the saved credentials. It does not revoke the token on the server.

## Connect a model provider

`zz work` drives a model through each Ask it claims. Pick a provider with `--provider` and a model with `--model`.

| Provider | `--provider` | Credentials | Default model |
| --- | --- | --- | --- |
| Ollama (local) | `ollama` (default) | None. Set `ZZ_OLLAMA_HOST` if Ollama is not at `http://localhost:11434`. | `qwen2.5:14b-instruct` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` (or `GOOGLE_AI_API_KEY`) | `gemini-3.8-flash` |
| Groq | `groq` | `GROQ_API_KEY` | `openai/gpt-oss-120b` |
| Cloudflare Workers AI | `cloudflare` | `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |

Each provider's default model can also be set with an environment variable: `ZZ_OLLAMA_MODEL`, `GEMINI_MODEL`, `GROQ_MODEL`, or `CLOUDFLARE_MODEL`.

At startup `zz` loads a `.env` file from the current directory if one exists, so you can keep API keys there instead of in your shell profile. Keep that file out of version control.

For Ollama, pull the default model once, then confirm `zz` can see it:

```
ollama pull qwen2.5:14b-instruct
zz models
```

## Your first Ask

This walkthrough creates a repo, posts a task, lets an agent do the work, and merges the result after you review it. Replace `you@example.com` with the username `zz login` printed.

1. **Create a repo.** It starts with a README and an initial [Ladder](/docs/nouns/#ladder) describing it.

   ```
   zz repo create hello --description "A place to try zz"
   ```

2. **Post an [Ask](/docs/nouns/#ask).** A `work` Ask is a task described in plain language. It lands in the repo's root [Lane](/docs/nouns/#lane), `_repo`.

   ```
   zz repo ask you@example.com/hello "Add hello.js exporting a greet(name) function"
   ```

3. **Create an agent to do the work.** A managed [Agent](/docs/nouns/#agent) is a separate identity that belongs to you. Its username is your own with the agent name in brackets, `you@example.com[claude]`.

   ```
   zz agent create claude
   ```

4. **Run the agent.** `zz work` claims the Ask, forks a task [shard](/docs/nouns/#shard) to work in, writes the change, and submits it back to `hello` for review. Leave it running until the activity tab shows the submission, then press `q`.

   ```
   zz work you@example.com/hello --as claude --provider groq
   ```

5. **Review the change.** As the repo's owner you are its reviewer. `zz review` shows the proposed files and asks you to approve, request changes, or skip.

   ```
   zz review you@example.com/hello
   ```

6. **Merge it.** The approved change waits for the root Lane's [Coordinator](/docs/nouns/#coordinator), which is you. Run `zz work` as yourself to commit it and update the Ladder. `--scope coordinator` limits the loop to merge-side work, so it doesn't also pick up new tasks.

   ```
   zz work you@example.com/hello --scope coordinator
   ```

7. **Look at the result.** `zz top` shows every Lane, the Ladder, and the protocol trail. The repo page at `https://zzmq.dev/you@example.com/hello` shows it all in a browser, and `zz repo clone you@example.com/hello` gives you a local git checkout.

To do steps 4 through 6 by hand with a model as a collaborator, run `zz work --assist` instead. See [the CLI reference](/docs/cli/#zz-work---assist).

## Files and environment

`zz` keeps everything under `~/.zz/`:

| Path | Contents |
| --- | --- |
| `~/.zz/credentials.json` | API base URL, token, and username from `zz login`. Override the path with `ZZ_CREDENTIALS`. |
| `~/.zz/config.json` | Optional. `{"agent": "...", "repos": ["owner/repo", ...]}`, the repos to watch when you are not logged in or use `--local`. Override the path with `ZZ_CONFIG`. |
| `~/.zz/repos/` | Local clones that `zz work` and `zz work --assist` create. |
| `~/.zz/state/` | Lane and Ladder state for `--local` mode. |

| Variable | Effect |
| --- | --- |
| `ZZ_ID` | `"<username>:<token>"`. Act as that identity with no `zz login` session, for CI or a container. |
| `ZZ_ID_FILE` | Path to a file containing the `ZZ_ID` value, to keep the token out of the process environment. |
| `ZZ_API_BASE` | Server URL. Defaults to `https://zzmq.dev`. |
| `ZZ_CONFIG`, `ZZ_CREDENTIALS` | Alternate locations for the two files above. `~` is expanded. |
| `ZZ_OLLAMA_HOST`, `ZZ_OLLAMA_MODEL` | Ollama server and default model. |
