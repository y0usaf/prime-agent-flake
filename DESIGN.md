# DESIGN — agents/resume as a persistent left sidebar

Status: implemented as a patch applied to `primeAgentSrc` in this flake.
Upstreaming: the three source patches (`tui-left-rail`, `coding-agent-agents-sidebar`, `tui-overlay-rail`) were converted into real commits and opened as **PR #796** (`feat: persistent agents/resume left sidebar + overlay layout fix`) against `PrimeIntellect-ai/prime-agent` (branch `y0usaf:sidebar`). The flake continues to apply the patches locally until they land upstream.

## Locked decisions

- **2026-08-06 — Sidebar is a native TUI-level left rail, not an extension.**
  `extensions/prime-agent-sidebar` + `patches/client-ui-extension-pass.patch`
  (commits `d9a10fa8`/`6470172b`) were reverted: the extension ran in two
  processes (daemon worker + client UI pass), needed a marker-file liveness
  hack to avoid double rendering, and its own CONTRACT.md admitted the fatal
  flaw — a separate daemon client cannot `reattach` the interactive client, so
  switching sessions from the sidebar was nearly always refused
  (`session_already_active`). The native rail avoids all of that: the sidebar
  lives inside the interactive TUI process, and switching reuses
  `AgentConnection.switchSession` (in-place, already handled by
  `session_replaced` in interactive-mode).

- **2026-08-06 — The rail reserves left columns at the TUI layer.** The TUI
  (`packages/tui`) has only vertical stacking (`Container.render`); there is
  no horizontal layout primitive. Fullscreen mode (the default chat layout)
  renders `scroll` components into a viewport and bypasses the normal root
  render, so a sidebar added as a Container child would not appear in
  fullscreen. The rail therefore lives in `TUI.doRender` and
  `TUI.renderFullscreen`: base content renders at `width - railWidth` and is
  shifted right; the rail component is composited over `[0, railWidth)`
  (reusing `compositeLineAt`). In fullscreen, images are placeholders, so
  shifting is safe there. In inline mode, image lines are left unshifted
  (rare, non-crashing; the rail's overlay skips image lines by design).

- **2026-08-06 — The sidebar data source is its own `DaemonClient`, reusing
  agents-view's pure roster helpers.** The sidebar polls `list` +
  `list_saved_sessions` + heartbeats over a `DaemonClient` on the same socket
  (exactly what `agents-view-mode` does), then builds rows with
  `reconcileUnifiedSessions` / `buildUnifiedSessionIndex` /
  `buildAgentsViewRows` from `agents-view-state.ts`. No daemon protocol
  change: all commands (`list`, `list_saved_sessions`, `heartbeats_list`,
  `kill`) already exist and are gated by `DAEMON_COMMAND_COMPATIBILITY`.

- **2026-08-08 — The sidebar shares the roster, not the mode.** The full
  agents/resume screen (`AgentsViewMode`) is a standalone TUI program — it
  constructs its own `TUI`/terminal/editor/dock and is launched by ending
  interactive mode (`returnToAgentsView`), so it cannot be embedded in the
  rail as-is. "Retain functionality" therefore means: the sidebar renders the
  *same* `buildAgentsViewRows` roster (sharing the expansion set so subagent
  trees match the screen) and drives the *same* daemon commands (`rename`,
  `kill`, `delete_saved_session`) the screen uses. So the sidebar never
  diverges from the roster while staying a narrow, in-process rail. Reply/
  program-cycling/new-session stay on the full screen (see Deferred).

- **2026-08-08 — The sidebar renders through the *same* row pipeline as the
  mode, compressed.** The earlier sidebar hand-rolled its own compact row
  renderer, which meant two divergent render paths for the same roster. The
  shared module `agents-view-render.ts` is now the single render path: both
  `AgentsViewMode` and `AgentsSidebar` call `renderAgentsViewRow` /
  `finalizeAgentsViewLine` with the same options, so the sidebar is literally
  the agents view's roster rendering narrowed to rail width — the same icon,
  styled title, summary suffix and age/details column, truncated to fit. One
  render path, no drift. The only rail-specific option is `compactDeleteHint`
  (the short `!delete?` armed hint instead of the full "ctrl+x again to
  remove"); the subagent `▸` fold and spawn-code hint come from the same
  subagent-summary branch.

- **2026-08-08 — The sidebar drives the *same* keys as the mode, via a shared
  dispatcher.** The agents view's `handleInput` was a private decision tree;
  the sidebar had its own reduced `app.sidebar.*` dispatch, so ctrl+n (new),
  ctrl+x (delete), ctrl+r (rename), space (reply) and ctrl+o (program) worked
  only in the full screen. `agents-view-actions.ts` is now the single key
  dispatch: `resolveAgentsViewKeyAction(data, kb, state)` maps any input chunk
  to an action (rename/delete/reply/new/program/open/clear/nav/cancel/text),
  and both `AgentsViewMode.handleInput` and `AgentsSidebar.handleInput` switch
  on it. The sidebar therefore has the full agents-view keybinding set for
  free — search-as-you-type filters the rail, ctrl+n starts a new session in
  place, ctrl+x two-step deletes, ctrl+r renames inline, Enter opens/expands.
  One dispatch implementation, no drift.

## Architecture

- `packages/tui/src/tui.ts` — `TUI.setLeftRail(component, width)` +
  `compositeLeftRail`; width reservation in `doRender` and `renderFullscreen`.
  This is the extension boundary for the rail (decision-making: TUI — where
  reserved columns come from; machinery: coding-agent sidebar component).
- `packages/coding-agent/src/modes/agents-view/agents-view-render.ts` — the
  shared row-rendering pipeline (`renderAgentsViewRow`, `finalizeAgentsViewLine`).
  Both the full view and the sidebar render through it with the same options;
  the sidebar is the same roster rendering at rail width (truncation handles
  the narrow column). This is the single render path (least-code: one renderer,
  not two).
- `packages/coding-agent/src/modes/agents-view/agents-view-actions.ts` — the
  shared key-action dispatcher (`resolveAgentsViewKeyAction`). Both the full
  view and the sidebar switch on its action union, so every agents-view
  keybinding works in the rail (ctrl+n/x/r, space, ctrl+o, up/down/page,
  search text). Single dispatch path (least-code: one dispatcher, not two).
- `packages/coding-agent/src/modes/interactive/agents-sidebar.ts` — the
  sidebar component: daemon polling, roster rows, selection, key handling,
  actions (switch/kill/refresh/search/toggle; subagent-tree expand/collapse,
  inline rename via the daemon `rename` command, and two-step delete via
  `deleteDaemonSavedSession` or `kill`). Roster rows and the expansion set are
  built with the same `buildAgentsViewRows(summaries, expandedSubagentParents)`
  call the full-screen view uses, so the sidebar never diverges from the
  agents/resume roster.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — owns the
  sidebar instance: creates it when daemon-backed (`daemonSocketPath` set),
  sets the rail, routes keys, disposes it in `stop()`.
- No daemon state is owned by the sidebar daemon-side; the daemon is
  untouched. Client-side state: current selection index, cached roster.

## Deferred

- Mouse (click/wheel) on the sidebar — keyboard-first, like agents-view.
- Configurable sidebar width — fixed width constant for now
  (`SIDEBAR_WIDTH` = 30 columns). (The on/off toggle itself is implemented:
  `app.sidebar.toggle` keybinding + `/sidebar [on|off]`, see
  `patches/sidebar-toggle.patch`.)
- Breakout to the full-screen agents view while the rail is shown — the visible
  rail replaces the left-arrow handoff; the full view stays reachable via
  `prime-agent agents` CLI. When the rail is toggled **off**, the left-arrow
  (`app.agents.back`) handoff falls through to the full-screen agents/resume
  view so the agents/resume path is never hidden away.
- Reply / follow-up composer, program-cycling, and in-place new-session in the
  sidebar — these need a reply-composer UI (cramped at rail width) or an
  in-place fresh-session switch that the embedded rail can't do safely (the
  full screen ends interactive mode and runs a fresh program). The sidebar
  exposes the roster-management parity a narrow rail can host (switch/expand/
  rename/delete/search/kill); the rest stays reachable via `/agents`.

## Roadmap

- [x] Phase 1 — `RowContainer`-free TUI left-rail reservation (doRender +
      renderFullscreen) with a placeholder rail component.
- [x] Phase 2 — AgentsSidebar: daemon poll + roster rows + selection render.
- [x] Phase 3 — Keyboard: focus toggle (left arrow with empty editor),
      up/down/enter/esc/x; wire switch/kill.
- [x] Phase 4 — `nix build .#` + `nix flake check` pass; patches committed as
      `patches/tui-left-rail.patch` + `patches/coding-agent-agents-sidebar.patch`.

## Verification

- `nix build .#` and `nix flake check` both pass (sidebar on/off toggle patch
  included in both).
- Toggle verification (2026-08-08): `app.sidebar.toggle` (`ctrl+s`) from the
  editor hides the rail — base content reflows back to the full width — and toggles
  it back on with the roster intact (polling continues while hidden). `/sidebar`,
  `/sidebar on`, `/sidebar off` set the same state; `/sidebar already-visible`
  reports a usage error. Pressing `ctrl+s` while the rail itself is focused also
  toggles it (returns focus to the editor). Both binds are listed under `/hotkeys`.
  The change is gated by the daemon socket (no-op in non-daemon runs).
- `nix build .#` and `nix flake check` both pass (recorded below for the original
  sidebar).
- PTY smoke test of the built bundle against a live daemon:
  - Sidebar renders always-visible on the left (agents header, Running/Idle
    sections, session rows with working/idle icons, `↓ N more`), with a
    pi-harness-style cyan `│` rail at its right edge and the selected row in
    reverse video (inverse fg/bg).
  - Main content (logo, chat, footer) reflows into the remaining columns.
  - Left arrow focuses the sidebar; up/down scroll the selection; escape
    releases focus; no teardown to the full-screen agents view.
  - Enter on a row switches the current client **in place** via
    `AgentConnection.switchSession` — the chat rebuilt with the target
    session's transcript and model (footer showed the target model + context
    usage), the `session_replaced` listener handled the rebuild.
  - No crashes across the whole interaction.
- Rail viewport anchoring: `compositeLeftRail` composites over the visible
  viewport (bottom terminal-height rows), matching overlay anchoring, so the
  rail stays pinned on long transcripts in inline (non-fullscreen) mode too
  (fullscreen mode composites over the viewport frame by construction).
- Rail alignment: every sidebar line (header text, section titles, rows) is
  padded to the full rail width before the `│` is appended, so the rail
  column is straight top to bottom; the rail renders for the full terminal
  height (`rows`, not `rows - 1`) so the bottom row's rail slot is filled.
- Rail overflow (2026-08-06 fix): the rail must never change the frame's row
  count. The previous `compositeLeftRail` appended rail rows beyond the
  visible viewport to the frame; when the roster rendered more lines than the
  terminal (section headers inflate the window past `maxLines`), the frame
  became over-tall and the fullscreen painter clips from the top, shifting
  the whole window up (and the raw `.slice(0, railWidth)` appended rows
  mangled ANSI mid-sequence). Fix: (1) `compositeLeftRail` clips excess rail
  rows instead of appending them; (2) `renderRows` counts section headers
  against the visible-window budget and reserves the last line for the
  `↓ N more` indicator, so the roster output is always exactly `rows` lines.
  Verified by PTY capture at 20/24/30/40 rows, narrow widths, inline mode,
  and mid-run resizes: the dock stays pinned to the bottom in every case.
- Input fixes (after 5ad8841): `r` now repaints after a forced refresh
  (`refreshNow?.().then(() => requestRender())`); Enter on the current-session
  row or on a live session without a saved file releases sidebar focus (the
  sessionFile guard errors after unfocusing) instead of trapping it.
  Verified: `npx tsc --noEmit` on coding-agent + `nix flake check` pass.
