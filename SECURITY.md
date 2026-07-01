# Security Policy

claude-desktop-gateway runs a local HTTP server that holds OpenRouter API
keys and/or Codex/Hermes OAuth tokens, and rewrites Claude Desktop's inference
requests. Credential handling bugs here are security issues, not ordinary bugs.

## Supported versions

This project is pre-1.0 and tracks the `main` branch only. Security fixes
land on `main`; there are no maintained release branches yet.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security reports.

Instead, use [GitHub's private vulnerability reporting](https://github.com/luckeyfaraday/claude-desktop-gateway/security/advisories/new)
for this repository. If that's unavailable, email the maintainer listed on
the [GitHub profile](https://github.com/luckeyfaraday) with details and
reproduction steps.

Please include:

- The gateway involved (OpenRouter, OpenCode, or Codex OAuth) and your OS.
- Steps to reproduce, including any relevant request/response shapes
  (**redact API keys and OAuth tokens before sharing them**).
- The impact you'd expect (credential exposure, token leakage to an
  unintended host, local privilege issue, etc.).

## Scope notes

- Credentials are written to per-OS config directories with best-effort
  restricted file permissions (`0600`/`0700`). Filesystem-level access
  control on the host is out of scope; the threat model is "another local
  process reading the file," not "an attacker with disk access."
- The Codex OAuth gateway talks to an unofficial backend (the ChatGPT Codex
  API used by Codex CLI/Hermes). It only forwards requests to the configured
  `CODEX_BASE_URL`/`CODEX_OAUTH_TOKEN_URL`; report any code path that sends
  tokens elsewhere.
- The OpenCode gateway holds no credentials of its own. It talks only to a
  local OpenCode server (`opencode serve`), which owns all provider auth and
  model routing.
- The gateway binds to `127.0.0.1` by default. Setting
  `OPENROUTER_GATEWAY_HOST`, `OPENCODE_GATEWAY_HOST`, or `CODEX_GATEWAY_HOST`
  to a non-loopback address
  exposes the local API key or OAuth bearer path to your network; that's
  expected behavior, not a vulnerability, but we're happy to discuss safer
  defaults.
