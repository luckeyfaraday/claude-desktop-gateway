# Phase 0 — protocol capture

The shim must emit bytes the Claude Desktop renderer's SSE parser accepts. We don't have that
spec; we capture it from a real session. **Everything else depends on these samples.**

## What we need to record

For one real chat turn, the streaming completion call:

- **Request**: method, full URL (`POST .../chat_conversations/{uuid}/completion`), headers,
  and JSON body (how the app encodes the prompt, model field, attachments, MCP tools).
- **Response**: the raw **SSE stream**, byte-for-byte — every `event:`/`data:` line, in order,
  including start/delta/stop events, tool-use events, and the terminal event. This is the
  schema `src/sse-encoder` must reproduce exactly.

Save raw samples to `capture/samples/` (gitignored if they contain account identifiers —
scrub org/conversation UUIDs and tokens before committing anything).

## Two capture methods

### A. Chromium DevTools (no extra trust setup)
Claude Desktop is Electron; enable devtools on the renderer and read the Network tab's
EventStream for the completion request. Simplest if devtools can be opened on the build.

### B. mitmproxy (authoritative, byte-exact)
```bash
pipx install mitmproxy        # or: uv tool install mitmproxy
mitmdump -w capture/samples/session.flows \
  --set flow_detail=3 \
  ~/path/to/dump-completion-addon.py
```
Trust mitmproxy's CA in the system store (Chromium net stack honors it). Filter to
`claude.ai` and dump only the `/completion` flow. Watch for HSTS; no hard cert pinning is
expected on the app's own API.

## Prereq: get Claude Desktop running on Linux

Official builds are Mac/Windows only. On Linux, build the unofficial repack:

```bash
git clone https://github.com/aaddrick/claude-desktop-debian
# follow its README to produce a .deb / .AppImage (it unpacks + repacks app.asar)
```

This same repack is our injection point in Phase 4.
