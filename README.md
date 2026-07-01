# claude-desktop-gateway

[![CI](https://github.com/luckeyfaraday/claude-desktop-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/luckeyfaraday/claude-desktop-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js >=18.17](https://img.shields.io/badge/node-%3E%3D18.17-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#requirements)

**claude-desktop-gateway runs Claude Desktop on OpenRouter models, OpenCode
Console/Zen models, or a ChatGPT Codex OAuth backend**, using Claude Desktop's
own supported third-party ("3P") inference mode. It's a small local HTTP
gateway plus setup scripts — no patching, no reverse-engineered protocol, no
Anthropic API key required.

```
Claude Desktop -> local gateway -> OpenRouter Anthropic-compatible /v1/messages
Claude Desktop -> local gateway -> OpenCode Console/Zen OpenAI-compatible API
Claude Desktop -> local gateway -> ChatGPT Codex OAuth Responses API
```

The gateway keeps your OpenRouter API key, OpenCode OAuth token, or
Codex/Hermes OAuth token out
of Claude Desktop's own config, and maps the model route Claude Desktop
expects (`claude-sonnet-4-5`) to whichever upstream model you actually want —
any [OpenRouter](https://openrouter.ai) model (GPT, Gemini, Llama, DeepSeek,
Grok, and more), OpenCode Zen models, or GPT-5.5 models via a Codex OAuth backend.

## Table of contents

- [Why this exists](#why-this-exists)
- [Features](#features)
- [Requirements](#requirements)
- [Quickstart (CLI)](#quickstart-cli)
- [Switching back to official Claude Desktop](#switching-back-to-official-claude-desktop)
- [Desktop app](#desktop-app-recommended-for-non-technical-users)
- [Codex OAuth / GPT models](#codex-oauth--gpt-models)
- [OpenCode OAuth / Zen models](#opencode-oauth--zen-models)
- [Using a different OpenRouter model](#using-a-different-openrouter-model)
- [Native wrappers](#native-wrappers)
- [Platform paths](#platform-paths)
- [Layout](#layout)
- [FAQ](#faq)
- [Security notes](#security-notes)
- [Contributing](#contributing)
- [License](#license)

## Why this exists

Claude Desktop's official inference path only talks to Anthropic's hosted
API under an Anthropic subscription or API key. Current Claude Desktop
builds also ship a supported third-party inference mode (`deploymentMode:
"3p"`) that lets the app point at any OpenAI/Anthropic-compatible HTTP
endpoint instead. claude-desktop-gateway is that endpoint: a local server
that speaks the shape Claude Desktop expects and forwards real requests to
OpenRouter, OpenCode/Zen, or a Codex OAuth backend.

## Features

- **OpenRouter gateway** (`src/openrouter-gateway.mjs`) — exposes
  `/v1/messages`, `/v1/models`, and `/health`, and rewrites Claude Desktop's
  requests to any OpenRouter model.
- **Codex OAuth gateway** (`src/codex-oauth-gateway.mjs`) — same
  Anthropic-shaped local API, forwarded to the ChatGPT Codex backend using
  local Codex CLI / Hermes OAuth tokens, with automatic token refresh.
- **OpenCode OAuth gateway** (`src/opencode-oauth-gateway.mjs`) — same
  Anthropic-shaped local API, forwarded to the OpenCode Console remote config
  and OpenAI-compatible model endpoint using an OpenCode device-login token.
- **One-command Claude Desktop configuration**
  (`scripts/configure-openrouter.mjs`) — writes Claude Desktop's 3P config to
  the correct per-OS location.
- **One-command restore** (`scripts/restore-claude.mjs`) — switches Claude
  Desktop back to its official, Anthropic-hosted mode, for whenever the
  gateway isn't running and you still want Claude Desktop to work.
- **Cross-platform launchers** — `npm run ...` commands plus native `.sh`
  and `.cmd` wrappers for macOS, Linux, and Windows.
- **Optional Electron tray app** — sign-in, start/stop, and configuration
  from a GUI, for users who don't want a terminal. The settings window shows
  session token usage for completed gateway requests.
- **No required dependencies for the CLI path** — the gateways and scripts
  are plain Node.js; only the desktop app needs `npm install` (for
  Electron).

## Requirements

- Claude Desktop with third-party gateway mode.
- Node.js 18.17 or newer.
- The CLI workflow needs no npm dependencies. The optional desktop app
  (`app/`) needs `npm install` to pull in Electron.

## Quickstart (CLI)

The `npm run ...` commands work on macOS, Windows, and Linux.

Configure Claude Desktop 3P mode:

```bash
npm run configure
```

Log in to OpenRouter once with OAuth:

```bash
npm run login
```

This opens a browser, completes OpenRouter PKCE login, and stores the
generated OpenRouter key locally outside Claude Desktop's config.

Start the gateway before launching Claude Desktop:

```bash
npm run gateway
```

By default, Claude Desktop sees `claude-sonnet-4-5` and the gateway forwards
to `anthropic/claude-sonnet-4.5` on OpenRouter.

The gateway logs token usage for completed requests and exposes the current
session totals from `GET /health` under `usage`. The Electron app reads that
same health payload for its token usage panel.

## Switching back to official Claude Desktop

Claude Desktop reads its deployment mode from the same config file
`npm run configure` writes — it checks that file on every launch, regardless
of how it's started. If the gateway isn't running, Claude Desktop will fail
inference rather than silently falling back to Anthropic. To switch back to
official, Anthropic-hosted mode:

```bash
npm run restore
```

Then quit Claude Desktop completely (including the tray icon) and relaunch
it. Run `npm run configure` again whenever you want gateway mode back.

## Desktop app (recommended for non-technical users)

A small Electron tray app wraps the same gateway, OAuth, and configure logic
behind a GUI — no terminal required. It does not reimplement anything; it
spawns the existing `src/` and `scripts/` modules as child processes.

**Download a prebuilt installer** from the
[Releases page](https://github.com/luckeyfaraday/claude-desktop-gateway/releases)
(AppImage for Linux, dmg for macOS, exe for Windows) — no Node.js or
terminal required. The build isn't code-signed, so macOS will show an
"unidentified developer" warning and Windows SmartScreen may warn on first
run; both are expected for an unsigned open-source build.

Or run it from source:

```bash
npm install      # one-time, pulls in Electron + electron-builder
npm run app      # launch the tray app
```

From the tray menu (or the **Settings…** window) you can:

- **Sign in to OpenRouter** — runs the PKCE OAuth flow in your browser.
- **Start / Stop gateway** — supervises the gateway process; the tray icon
  turns green when `/health` is live.
- **Configure Claude Desktop** — writes the `Claude-3p` config. Relaunch
  Claude Desktop afterward.
- **Restore official Claude Desktop** — switches Claude Desktop back to its
  normal, Anthropic-hosted mode. Use this when the gateway isn't running and
  you still want Claude Desktop to work.
- **Pick the model, host, and port** — changing them restarts the gateway.
- **Launch at login / start gateway on launch** — so the gateway is up
  before Claude Desktop needs it.

Build a distributable installer (AppImage / dmg / nsis) with:

```bash
npm run dist
```

> Linux "launch at login" writes `~/.config/autostart/*.desktop`. On macOS
> and Windows it uses the OS login-item API. Shipping to other machines
> means code-signing the installer to avoid "unidentified developer"
> warnings.

## Codex OAuth / GPT models

This path uses the same local OAuth token shape as Codex CLI and Hermes'
`openai-codex` provider. It is not the public OpenAI API-key path; it talks
to the ChatGPT Codex backend and may break if that private backend changes.

Log in with Codex CLI or Hermes first:

```bash
codex login
# or:
hermes auth add openai-codex
```

Then start the Codex gateway:

```bash
npm run codex
```

The Codex gateway also logs completed-request token usage and includes session
totals in `GET /health` under `usage`.

By default it forwards Claude Desktop requests to `gpt-5.5`. Override it
with:

```bash
CODEX_MODEL=your-codex-model-id npm run codex
```

The local route model still defaults to `claude-sonnet-4-5` because Claude
Desktop's 3P mode expects a Claude-looking model label. That label is only
the route Claude Desktop sees; the gateway logs `Codex upstream model: ...`
for the real model sent upstream.

## OpenCode OAuth / Zen models

This path is separate from Codex OAuth. It uses the same OpenCode account
device OAuth flow that OpenCode itself uses for your OpenCode plan. The login
host is `https://console.opencode.ai`, which acts as OpenCode's account/org
control plane: the gateway uses that token to fetch your plan-backed remote
provider config, then forwards Claude Desktop requests to the selected
OpenCode/Zen OpenAI-compatible model endpoint.

Log in to your OpenCode account once:

```bash
npm run login:opencode
```

Then start the OpenCode gateway:

```bash
npm run opencode
```

The wrapper defaults to provider `opencode` and lets OpenCode's remote config
choose the first available model if `OPENCODE_MODEL` is unset. Override the
selection with:

```bash
OPENCODE_PROVIDER=opencode \
OPENCODE_MODEL=your-opencode-model-id \
npm run opencode
```

Set `OPENCODE_CONSOLE_URL` only if your OpenCode account/plan is served by a
different OpenCode-compatible control plane, `OPENCODE_BASE_URL` to force the
OpenAI-compatible upstream base URL, or `OPENCODE_ACCESS_TOKEN` /
`OPENCODE_ORG_ID` to run from an externally supplied OpenCode OAuth token.

## Using a different OpenRouter model

macOS/Linux:

```bash
OPENROUTER_MODEL=your/openrouter-model-id \
npm run gateway
```

Windows PowerShell:

```powershell
$env:OPENROUTER_MODEL = "your/openrouter-model-id"
npm run gateway
```

You can still override OAuth storage with an environment key:

macOS/Linux:

```bash
OPENROUTER_API_KEY=... npm run gateway
```

Windows PowerShell:

```powershell
$env:OPENROUTER_API_KEY = "..."
npm run gateway
```

Then relaunch Claude Desktop.

## Native wrappers

macOS/Linux:

```bash
./scripts/configure-openrouter.sh
./scripts/restore-claude.sh
./scripts/login-openrouter.sh
./scripts/login-opencode.sh
./scripts/run-openrouter-gateway.sh
./scripts/run-codex-gateway.sh
./scripts/run-opencode-gateway.sh
```

Windows:

```bat
.\scripts\configure-openrouter.cmd
.\scripts\restore-claude.cmd
.\scripts\login-openrouter.cmd
.\scripts\login-opencode.cmd
.\scripts\run-openrouter-gateway.cmd
.\scripts\run-codex-gateway.cmd
.\scripts\run-opencode-gateway.cmd
```

## Platform paths

Claude Desktop 3P config:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude-3p/` |
| Windows | `%LOCALAPPDATA%\Claude-3p\` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/Claude-3p/` |

OpenRouter OAuth credential:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/claude-openrouter-gateway/openrouter.json` |
| Windows | `%LOCALAPPDATA%\claude-openrouter-gateway\openrouter.json` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/claude-openrouter-gateway/openrouter.json` |

Set `CLAUDE_3P_DIR` to override the Claude Desktop config root, or
`OPENROUTER_AUTH_FILE` to override the OpenRouter credential file.

OpenCode OAuth credential:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/claude-openrouter-gateway/opencode.json` |
| Windows | `%LOCALAPPDATA%\claude-openrouter-gateway\opencode.json` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/claude-openrouter-gateway/opencode.json` |

Set `OPENCODE_OAUTH_FILE` to override this project's OpenCode credential file.

Codex OAuth credential lookup:

1. `CODEX_ACCESS_TOKEN` / `OPENAI_CODEX_ACCESS_TOKEN`
2. `CODEX_AUTH_FILE`, or `${CODEX_HOME:-~/.codex}/auth.json`
3. `HERMES_AUTH_FILE`, or `${HERMES_HOME:-~/.hermes}/auth.json`

If an access token is expiring, the gateway refreshes it with the local
refresh token and writes the rotated token pair back to the same file.

## Layout

```
src/          # local OpenRouter, OpenCode OAuth, and Codex OAuth gateways
scripts/      # config + gateway launch helpers
app/          # optional Electron tray app
package.json
```

## FAQ

**Do I need an Anthropic API key or Claude subscription to use this?**
No. claude-desktop-gateway routes Claude Desktop's requests to OpenRouter,
OpenCode/Zen, or a Codex OAuth backend instead of Anthropic. You authenticate
to OpenRouter, OpenCode Console, or Codex CLI/Hermes, not to Anthropic.

**Can I use GPT-5.5, Gemini, Llama, or other non-Claude models inside Claude
Desktop?**
Yes. Set `OPENROUTER_MODEL` to any model ID OpenRouter serves, or use the
OpenCode OAuth gateway for OpenCode/Zen models, or use the Codex OAuth gateway
for GPT-5.5 models through the ChatGPT Codex backend.

**Is this an official Anthropic, OpenRouter, or OpenAI project?**
No. It's an independent, unofficial local gateway that uses Claude
Desktop's documented third-party inference mode plus OpenRouter, OpenCode
Console, and Codex CLI/Hermes OAuth flows.

**Why does Claude Desktop still show `claude-sonnet-4-5` as the model?**
Claude Desktop's 3P mode validates that the route name looks like a
Claude/Anthropic model. The gateway exposes that route name locally while
rewriting the actual upstream model (`OPENROUTER_MODEL`, `OPENCODE_MODEL`, or
`CODEX_MODEL`) behind it — check `/health` or the gateway logs to see what's
really being called.

**Where are my API keys and OAuth tokens stored?**
Locally, outside Claude Desktop's own config — see [Platform
paths](#platform-paths). They're never sent anywhere except the configured
upstream (OpenRouter, OpenCode Console/model endpoints, or the Codex backend).

**What happens if the gateway isn't running?**
Claude Desktop will fail inference against `http://127.0.0.1:8787` (or
whatever host/port you configured). Start the gateway (`npm run gateway`,
`npm run opencode`, or `npm run codex`) before launching Claude Desktop, or
run `npm run restore` (or click **Restore official Claude Desktop** in the
tray app) to switch Claude Desktop back to official, Anthropic-hosted mode
instead.

**Does this work on Windows and Linux, not just macOS?**
Yes — the CLI, scripts, and Electron app are all cross-platform; see
[Platform paths](#platform-paths) for per-OS config locations.

## Security notes

- Claude Desktop's gateway model validation expects Claude/Anthropic-looking
  route names. The local gateway handles this by exposing
  `claude-sonnet-4-5` while rewriting the upstream OpenRouter, OpenCode, or
  Codex `model`.
- OpenRouter OAuth creates a user-controlled OpenRouter API key and stores
  it locally with best-effort restricted file permissions. The gateway
  reads that file, or `OPENROUTER_API_KEY` if set.
- Codex OAuth uses existing local Codex/Hermes OAuth tokens. The gateway
  does not print tokens and sends them only to the configured Codex
  backend.
- OpenCode OAuth uses this project's own OpenCode account device-login token.
  The gateway sends it to OpenCode's account/control-plane service for config
  lookup/token refresh and to the selected OpenCode model endpoint as bearer
  auth.
- If the gateway is not running, Claude Desktop will fail inference against
  `http://127.0.0.1:8787`. Run `npm run restore` to switch Claude Desktop
  back to official, Anthropic-hosted mode.

See [SECURITY.md](./SECURITY.md) for the full threat model and how to
report vulnerabilities.

## Contributing

Bug reports, feature requests, and pull requests are welcome — see
[CONTRIBUTING.md](./CONTRIBUTING.md). This project follows the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE)
