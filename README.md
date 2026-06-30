# claude-desktop-shim

Run **Claude Desktop** through **OpenRouter** or **Codex OAuth** using Claude Desktop's
built-in third-party gateway mode.

The old plan in [`FEASIBILITY.md`](./FEASIBILITY.md) was to reverse-engineer and intercept
Claude Desktop's private `/completion` stream. Current Claude Desktop builds include a
supported third-party inference mode, so the practical path is now much simpler:

```
Claude Desktop -> local gateway -> OpenRouter Anthropic-compatible /v1/messages
Claude Desktop -> local gateway -> ChatGPT Codex OAuth Responses API
```

The local gateway keeps the OpenRouter API key out of Claude Desktop's config and can map
Claude Desktop's expected model route, `claude-sonnet-4-5`, to any OpenRouter model ID.

## Status

**OpenRouter and Codex OAuth gateway paths wired locally.**

- `src/openrouter-gateway.mjs` exposes `/v1/messages`, `/v1/models`, and `/health`.
- `src/codex-oauth-gateway.mjs` exposes the same Anthropic-shaped local API and
  forwards to the ChatGPT Codex backend with local Codex/Hermes OAuth tokens.
- `scripts/configure-openrouter.mjs` writes Claude Desktop's 3P config to the correct
  per-OS location.
- `scripts/run-openrouter-gateway.mjs` starts the gateway with OpenRouter OAuth storage or
  `OPENROUTER_API_KEY`.
- `scripts/run-codex-gateway.mjs` starts the gateway with `~/.codex/auth.json` or
  `~/.hermes/auth.json` `openai-codex` credentials.
- Windows `.cmd` wrappers are provided beside the Unix shell wrappers.

This machine has already been configured to point Claude Desktop 3P mode at
`http://127.0.0.1:8787`.

## Requirements

- Claude Desktop with third-party gateway mode.
- Node.js 18.17 or newer.
- The CLI workflow needs no npm dependencies. The optional desktop app
  (`app/`) needs `npm install` to pull in Electron.

## Desktop app (recommended for non-technical users)

A small Electron tray app wraps the same gateway, OAuth, and configure logic
behind a GUI — no terminal required. It does not reimplement anything; it spawns
the existing `src/` and `scripts/` modules as child processes.

```bash
npm install      # one-time, pulls in Electron + electron-builder
npm run app      # launch the tray app
```

From the tray menu (or the **Settings…** window) you can:

- **Sign in to OpenRouter** — runs the PKCE OAuth flow in your browser.
- **Start / Stop gateway** — supervises the gateway process; the tray icon turns
  green when `/health` is live.
- **Configure Claude Desktop** — writes the `Claude-3p` config. Relaunch Claude
  Desktop afterward.
- **Pick the model, host, and port** — changing them restarts the gateway.
- **Launch at login / start gateway on launch** — so the gateway is up before
  Claude Desktop needs it.

Build a distributable installer (AppImage / dmg / nsis) with:

```bash
npm run dist
```

> Linux "launch at login" writes `~/.config/autostart/*.desktop`. On macOS and
> Windows it uses the OS login-item API. Shipping to other machines means
> code-signing the installer to avoid "unidentified developer" warnings.

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

This opens a browser, completes OpenRouter PKCE login, and stores the generated
OpenRouter key locally outside Claude Desktop's config.

Start the gateway before launching Claude Desktop:

```bash
npm run gateway
```

By default, Claude Desktop sees `claude-sonnet-4-5` and the gateway forwards to
`anthropic/claude-sonnet-4.5` on OpenRouter.

### Codex OAuth / GPT models

This path uses the same local OAuth token shape as Codex CLI and Hermes'
`openai-codex` provider. It is not the public OpenAI API-key path; it talks to
the ChatGPT Codex backend and may break if that private backend changes.

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

By default it forwards Claude Desktop requests to `gpt-5.5`. Override it with:

```bash
CODEX_MODEL=gpt-5.4-mini npm run codex
```

The local route model still defaults to `claude-sonnet-4-5` because Claude
Desktop's 3P mode expects a Claude-looking model label. That label is only the
route Claude Desktop sees; the gateway logs `Codex upstream model: ...` for the
real model sent upstream.

To use a different OpenRouter model:

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
./scripts/login-openrouter.sh
./scripts/run-openrouter-gateway.sh
./scripts/run-codex-gateway.sh
```

Windows:

```bat
.\scripts\configure-openrouter.cmd
.\scripts\login-openrouter.cmd
.\scripts\run-openrouter-gateway.cmd
.\scripts\run-codex-gateway.cmd
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

Codex OAuth credential lookup:

1. `CODEX_ACCESS_TOKEN` / `OPENAI_CODEX_ACCESS_TOKEN`
2. `CODEX_AUTH_FILE`, or `${CODEX_HOME:-~/.codex}/auth.json`
3. `HERMES_AUTH_FILE`, or `${HERMES_HOME:-~/.hermes}/auth.json`

If an access token is expiring, the gateway refreshes it with the local
refresh token and writes the rotated token pair back to the same file.

## Layout

```
src/          # local OpenRouter and Codex OAuth gateways
scripts/      # config + gateway launch helpers
capture/      # legacy traffic-capture notes from the old interception approach
FEASIBILITY.md
package.json
```

## Notes

- Claude Desktop's gateway model validation expects Claude/Anthropic-looking route names.
  The local gateway handles this by exposing `claude-sonnet-4-5` while rewriting the
  upstream OpenRouter or Codex `model`.
- OpenRouter OAuth creates a user-controlled OpenRouter API key and stores it locally with
  best-effort restricted file permissions. The gateway reads that file, or
  `OPENROUTER_API_KEY` if set.
- Codex OAuth uses existing local Codex/Hermes OAuth tokens. The gateway does not print
  tokens and sends them only to the configured Codex backend.
- If the gateway is not running, Claude Desktop will fail inference against
  `http://127.0.0.1:8787`.
