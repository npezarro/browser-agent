# context.md — browser-agent

Last Updated: 2026-04-09 — v1.7.0: file upload, clickAny, per-command timeout

## Current State
- **v1.7.0** deployed to VM and pezant.ca/browser-agent.user.js
- Server running via PM2 (`browser-agent`) on port 3102
- 40+ commands: navigate, click, type, setInput, fill, upload, clickAny, wait-for, assert, etc.
- File upload: blob relay (CLI → server → TM script) with 10MB limit, 5-min TTL
- `clickAny`: searches ALL elements for text (not just buttons) — essential for React custom dropdowns
- Per-command 20s timeout prevents queue poisoning from hung commands

## Key Issues Learned (2026-04-09)
- **CSP blocks eval** on FB, Google Photos, and many modern sites — `new Function()` fails
- **setInput** uses native value setters which bypass React onChange — this breaks autocomplete fields. Use `type` for searchable inputs.
- **Textarea setInput** must use `HTMLTextAreaElement.prototype.value.set`, not `HTMLInputElement` — causes "Illegal invocation"
- **Queue poisoning:** if a command hangs (React re-render loop), all subsequent commands timeout. Fixed with per-command timeout in v1.7.0.
- **Large file uploads:** base64 must go to temp file, not CLI argument (ARG_MAX limit)

## Open Work
- No scroll command exposed in CLI (action exists in TM script)
- eval alternative needed for CSP-restricted sites (consider GM_addElement with page nonce)
- Upload command only works with `input[type=file]` — FB's drag-drop zones need `--drag-drop` flag

## Environment Notes
- **Deploy target:** VM (pezant.ca)
- **SSH:** deployuser@pezant.ca, key: ~/.ssh/vm_key
- **Process manager:** PM2 (`browser-agent`)
- **Port:** 3102 (behind Apache at /api/browser-agent/)
- **TM script:** /var/www/html/browser-agent.user.js (install via pezant.ca/install.html)

## Active Branch
`master`

Full session closeout: privateContext/deliverables/closeouts/2026-04-09-fb-marketplace-poster.md
