# prime-agent-flake

Nix flake packaging [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)
(PrimeIntellect's fork of the pi coding agent) with a working IPython kernel
environment on NixOS.

The flake fetches upstream as a non-flake input (`primeAgentSrc`) — no code is
vendored here beyond nix glue:

- `extensions/` — shipped as built-in prime-agent extensions, loaded by the
  wrapper via `--extension` on every invocation (covers interactive, RPC,
  daemon, and subagent sessions; still active under `--no-extensions` since
  CLI-provided extension paths are always loaded). Extensions are preferred
  to patches because they don't rot on every `primeAgentSrc` bump.
  - `pi-chronobreak/` — "chronobreak": when the model repeats the same output
    over and over inside one turn (same normalized sentence/line >= 3 times),
    it aborts the run, scrubs the polluted assistant message down to a one-line
    marker, and re-injects a decisive-action directive (echoing the repeated
    sample) that re-runs the turn from a clean context. Gives up after 3
    strikes per user turn (abort + scrub only on the third, no re-run). This
    mirrors the `pi-chronobreak` extension from [pi-flake](https://github.com/y0usaf/pi-flake).
- `patches/` — minimal build-time patches applied to upstream (kept small:
  anything achievable via env var or an extension must not be a patch).
- `nix/package-lock.json` — upstream's committed lockfile with `resolved` +
  `integrity` restored (upstream strips them; prefetch-npm-deps drops such
  entries and `npm ci --offline` fails). Regenerate after `primeAgentSrc` bumps:
  `python3 nix/fix-lockfile.py <rev>`
- `nix/fix-lockfile.py` — regenerates the above from the npm registry.

## Usage

```sh
nix run github:y0usaf/prime-agent-flake
```

or add `inputs.prime-agent-flake.url = "github:y0usaf/prime-agent-flake";` and
install `pkgs.prime-agent-flake.packages.${system}.default`.

The wrapper sets `PRIME_AGENT_KERNEL_PYTHON` to a Nix-built Python with
ipykernel, `prime-agent-runtime`, and the built-in Python skills, since uv
auto-bootstrap cannot run on NixOS.

## Patched features

- **Agents/resume left sidebar** (`patches/tui-left-rail.patch` +
  `patches/coding-agent-agents-sidebar.patch`): the agents/resume roster is
  always visible as a left rail inside the chat view, with a cyan `│`
  separator rail at its right edge and the selected row in reverse video
  (pi-harness style). Left arrow (with an empty draft) focuses the rail;
  up/down navigate, Enter switches the current client to the selected session
  **in place**, `x` kills a live agent, `r` refreshes, Esc returns to the
  editor. See `DESIGN.md` for the full design and verification.
- **Sidebar on/off toggle** (`patches/sidebar-toggle.patch`): press `Ctrl+S`
  (or run `/sidebar [on|off]`) from the editor to show or hide the sidebar
  rail in place — the daemon polling keeps running, so toggling back on is
  instant. The bind is a first-class `app.sidebar.toggle` keybinding, so it
  is rebindable via `keybindings.json` and listed under `/hotkeys`. See
  `DESIGN.md` for the design and verification.
- **Sidebar is literally the agents/resume view, compressed**
  (`patches/agents-view-shared-rendering.patch` + `coding-agent-agents-sidebar.patch`):
  the agents-view *row renderer* (`agents-view-render.ts`) and *key dispatch*
  (`agents-view-actions.ts`) are shared modules that both the full screen and
  the sidebar drive. The sidebar is the agents view narrowed to rail width —
  the same icon, styled title, summary suffix and age/details column, truncated
  to fit — and it responds to the full agents-view keybinding set: search-as-
  you-type filters the roster, `Ctrl+N` starts a new session, `Ctrl+X` two-step
  deletes, `Ctrl+R` renames inline, Submit/Enter opens or expands a subagent
  tree, up/down/page navigate. One render path and one dispatch path instead of
  two divergent implementations, so the sidebar never drifts from the view.
## Updating upstream

```sh
nix flake update primeAgentSrc
python3 nix/fix-lockfile.py main          # if package-lock.json changed
nix build .# 2>&1 | grep 'got:'           # refresh npmDepsHash if deps changed
nix flake check
```
