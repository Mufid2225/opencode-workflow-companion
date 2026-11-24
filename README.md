# opencode-status-line

[![CI](https://github.com/Mufid2225/opencode-status-line/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Mufid2225/opencode-status-line/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/Mufid2225/opencode-status-line/blob/main/LICENSE)

A personal workflow plugin for [OpenCode](https://opencode.ai) v2. It combines
a configurable status line with session summaries, reusable instructions,
MCP recovery, a project PowerShell shortcut, and a live tool inventory.

<p align="center">
  <img src="assets/status-line.png" alt="A session with the status line at the bottom, showing context, cache, speed, cost, time and uncommitted changes" width="1080" />
</p>

The line itself:

```
███········▏ 26% — 262.0k │ ⧉ 99.6% — 260.9k │ ██████·····▏ ↯ 158 · μ  88 tok/s │ +6 -1 │ $0.18 │ 57m11s
```

From left to right, the line shows context window usage, cache usage, current
speed (`↯`) and turn average (`μ`) speed, uncommitted changes, session cost,
and elapsed time. Segments with nothing to show are hidden.

## What you get

- **Context window**: a bar showing how full the context window is, the
  percentage used, and the token count. The bar colour changes as the window
  fills.
- **Cache** (`⧉`): how much of the model's input came from cache, and the
  cached token count.
- **Speed**: the current streaming speed (`↯`) and the average for the turn
  (`μ`). When a stream stops, the speed segment rests at `↯ 0.0` in a dimmed
  colour with an empty gauge — the same shape a resumed session shows.
  `window.hold: "last"` keeps the last reading on screen instead, and `false`
  hides the segment whenever there is no live reading.
- **Cost and time**: the session's cost so far and how long it has been
  running.
- **Uncommitted changes**: added and removed line counts for staged, unstaged
  and untracked files, taken from OpenCode's VCS status. No `git` command is
  run.
- **Running shells**: the number of commands running right now. Click the
  count to open the composer's Shell tab.
- `/opencode-status-line` (alias `/tps`): opens a dialog with the detailed
  numbers behind the meter.
- **Session summaries**: `/summary` creates a persistent summary of completed
  work, current status, and next steps. `/summaries` lets you browse summaries
  from other sessions and attach selected ones as context to this session.
  Sessions are summarized after five minutes of inactivity; this never blocks
  quitting OpenCode.
- **Session instructions**: save reusable instructions, attach selected ones
  to every prompt in a session, or queue them for the next prompt with
  `/instruction`. Selected instructions also reach child agents.
- **MCP recovery**: failed servers get up to three background reconnect
  attempts. Disabled servers and servers waiting for authentication are left
  alone.
- **Project PowerShell**: `/terminal` or the **PowerShell** sidebar action opens
  a separate PowerShell window in the active project's directory on Windows.
- **Tool inventory**: the sidebar shows the registered tool count, an estimated
  schema-token footprint, and its share of the selected model's context. Click
  **Tools** to inspect names and descriptions. The inventory combines built-in,
  plugin, and MCP tools; it cannot attribute tools to individual MCP servers.

The line can be placed in one slot or in several at once, and each placement
can show its own segments. When the window is narrow, whole segments move to
the next row; in a sidebar they stack one per row. Built-in colour palettes:
Catppuccin, Dracula, Gruvbox, Nord, Rosé Pine, Tokyo Night, and the flat
`grey` and `white`.

### Workflow commands

| Command | What it does |
| --- | --- |
| `/summary` | Create or refresh the active session's summary. |
| `/summaries` | Browse saved summaries and attach selected summaries to this session. |
| `/instruction-add` | Save a reusable instruction and choose always-active or one-prompt mode. |
| `/instructions` | Choose instructions to apply throughout this session. |
| `/instruction` | Queue instructions for the next prompt. |
| `/instruction-toggle` | Enable or disable an instruction without deleting it. |
| `/instruction-delete` | Remove an instruction from the library. |
| `/terminal` | Open a new PowerShell window in the active project directory (Windows). |

The summary and instruction pickers use arrow keys, Space to select, Enter to
apply, and Esc to cancel. Summaries and instructions are kept in OpenCode's
plugin storage; selected context is saved with the session. The server
companion is required for this context to be added to prompts and subagents.

## Install

Requires OpenCode v2 and [Bun](https://bun.sh). This fork's workflow features
are installed from the Git checkout; the inherited npm package name still
belongs to the upstream project and does not contain these changes.

1. Clone the repository and install its dependencies:

   ```sh
   git clone https://github.com/Mufid2225/opencode-status-line.git
   cd opencode-status-line
   bun install
   ```

2. Add the TUI entry to `~/.config/opencode/cli.json`. Merge it into the
   existing `plugins` list if the file already exists:

   ```json
   {
     "plugins": ["C:/path/to/opencode-status-line/src"]
   }
   ```

3. Add the server companion to `~/.config/opencode/opencode.json`. Preserve
   any existing plugin entries:

   ```json
   {
     "plugin": ["C:/path/to/opencode-status-line/server-plugin"]
   }
   ```

   These are two separate OpenCode configuration files: `cli.json` loads the
   TUI, while `opencode.json` loads server-side context and the tool inventory
   RPC. The server plugin setting must point to the `server-plugin` directory.

4. Restart OpenCode and open a session. The status line appears below
   OpenCode's footer. Run `/opencode-status-line` (alias `/tps`) for meter
   details. Click **Tools** in the right sidebar to inspect the tool inventory.

Optionally hide OpenCode's own prompt footer by adding
`-opencode.prompt.footer` to the `plugins` list in `cli.json`:

```json
{
  "plugins": ["-opencode.prompt.footer", "C:/path/to/opencode-status-line/src"]
}
```

The checkout hot-reloads during development, so a build is not needed to run
it. See the [manual's install notes][checkout-install] and
[common questions and fixes][fixes] if something does not load.

## Quick start

Configuration is optional and written in JSON. Place it in
`~/.config/opencode/opencode-status-line.json` for every project, or in
`.opencode-status-line.json` in a project folder. The project file wins where
both set the same key. For example:

```json
{
  "usage": { "labels": "words" },
  "colors": { "palette": "catppuccin" },
  "cap": { "gaugeWidth": 14 }
}
```

This changes the labels from glyphs to words, applies the Catppuccin palette,
and widens the speed gauge. Settings are read when the plugin loads, so
restart OpenCode to apply a change. Invalid files and values produce a warning
and are ignored.

## Full manual

The [customization manual][manual] is the complete reference:

- [every setting, with its default and allowed values][settings]
- [choosing and ordering the segments][segments], per placement if you like
- [placing the line in one slot or several at once][placement], and padding it
- [understanding and tuning the speed meter][meter]
- [the bundled palettes, custom colours and per-segment opt-outs][themes]
- [session summaries, reusable instructions and MCP tools][session-features]
- [ready-made setups][setups] to copy
- [common questions and fixes][fixes]

## Development

```
bun test                    # the whole suite, no OpenCode needed
bun test test/rate.test.ts  # one module
bun install                 # once, for the typechecker
bun run typecheck           # src/, the tests and the entry
bun run build:entry         # dist/tui.js and dist/plugin.js
npm run check:pack          # source modules and both exported entries are packed
```

`src/tui.tsx` is the TUI entry and `src/plugin.ts` is the server companion.
`server-plugin/index.ts` is the directory wrapper used by checkout installs.
`src/rate.ts` holds the speed maths, `src/render.ts` the gauge and context-bar
geometry, `src/format.ts` the usage-line formatting, `src/diff.ts` the
uncommitted-change counter, `src/palette.ts` the bundled colour palettes, and
`src/config.ts` the JSON loader. The root `tui.tsx` re-exports the TUI entry so
OpenCode can load it from a checkout. npm consumers resolve both entries
through the `exports` map.

CI runs the suite on Linux, macOS and Windows for every pull request, together
with a typecheck of the source (the entry included), a build of the npm entry
and the tarball check. Contributions are welcome; see
[CONTRIBUTING.md][contributing] for the workflow, and `AGENTS.md` for the
host-API traps behind the entry.

## Packaging

The Git checkout is the supported install for this fork. `bun run build:entry`
creates `dist/tui.js` and `dist/plugin.js` for a package distribution; a
checkout install runs the source and does not need a build. `npm run
check:pack` verifies the package exports and tarball contents.

This fork still carries the upstream npm package name in `package.json`. Do
not publish a release under that name. An npm release needs a package name you
own and a matching trusted-publishing setup; until then, install from this
repository checkout. See [RELEASING.md][releasing] only after the package
identity has been changed for this fork.

[manual]: https://github.com/Mufid2225/opencode-status-line/blob/main/MANUAL.md
[settings]: https://github.com/Mufid2225/opencode-status-line/blob/main/MANUAL.md#10-all-settings-at-a-glance
[segments]: https://github.com/Mufid2225/opencode-status-line/blob/main/MANUAL.md#3-pick-the-parts-you-want
[placement]: https://github.com/Mufid2225/opencode-status-line/blob/main/MANUAL.md#4-move-the-line-around
[meter]: https://github.com/Mufid2225/opencode-status-line/blob/main/MANUAL.md#5-understand-and-tune-the-speed-meter
[themes]: https://github.com/Mufid2225/opencode-status-line/blob/main/MANUAL.md#6-colours-and-themes
[session-features]: https://github.com/Mufid2225/opencode-status-line/blob/main/MANUAL.md#session-summaries
[checkout-install]: https://github.com/Mufid2225/opencode-status-line/blob/main/MANUAL.md#install-both-plugin-entries-from-a-checkout
[setups]: https://github.com/Mufid2225/opencode-status-line/blob/main/MANUAL.md#11-ready-made-setups
[fixes]: https://github.com/Mufid2225/opencode-status-line/blob/main/MANUAL.md#12-common-questions-and-fixes
[issues]: https://github.com/Mufid2225/opencode-status-line/issues
[agents]: https://github.com/Mufid2225/opencode-status-line/blob/main/AGENTS.md
[contributing]: https://github.com/Mufid2225/opencode-status-line/blob/main/CONTRIBUTING.md
[releasing]: https://github.com/Mufid2225/opencode-status-line/blob/main/RELEASING.md
