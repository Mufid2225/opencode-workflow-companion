# ADR-0001: Session memory and summaries

## Status

Proposed

## Context

The ecosystem needs durable session summaries that survive deletion of the
source conversation, a picker for attaching selected summaries to a new
conversation, and per-session instructions. Summary generation must not block
normal prompting. The existing package is a TUI-only plugin, while prompt
context modification belongs to the OpenCode server plugin's
`session.hook("context", ...)` API.

The TUI and server plugin APIs expose different storage interfaces. TUI storage
is durable and synchronized between TUI instances; the server plugin has a
separate JSON storage domain. The public declarations do not guarantee that
both interfaces address the same records. The implementation must not assume
they share data until verified against the v2.2.7 host.

## Decision

Keep the ecosystem as one repository with two plugin entry points:

- a TUI entry for commands, the summary picker, status indicator, and controls;
- a server entry for prompt hooks, subagent propagation, and background work.

Persist summaries and instructions in a small versioned store keyed by project
and session. Keep source session IDs and timestamps as metadata, but make each
summary independently readable after the source session is removed. Store the
selected summary IDs in the new session's metadata; the `session.update`
declaration accepts JSON metadata, and the server context hook can use the
session ID to retrieve session state. Verify the metadata read path against the
host before relying on it. The hook loads only selected records and adds them
to the prompt. Imported summaries must not be treated as source material when
generating the active session's own summary.

The TUI owns the durable summary library. When the user selects summaries, it
copies only those summary snapshots into the active session's metadata. The
server context hook reads that session metadata and adds the selected snapshots
to prompts. This avoids depending on the TUI and server plugin storage APIs
sharing records. The same snapshot pattern can carry selected instructions.

The summary flow has three entry points that share one operation: `/summary`,
a picker/button action, and an idle timer after five minutes without prompt or
agent activity. Generation runs asynchronously. A compact indicator reports
idle, summarizing, complete, or failed. Old sessions are summarized only on
demand.

The custom picker lists one-line summaries, expands the focused item, supports
Space to select multiple items and Esc to return, and defaults to the active
project with an all-projects view. Selection applies to the new session only.

## Consequences

- The summary/picker feature requires both plugin entry points; a TUI-only
  implementation cannot reliably inject selected context into every prompt.
- The built-in `/session` dialog remains unchanged. The plugin provides its own
  picker because there is no supported plugin slot inside that dialog.
- Session metadata is the TUI/server handoff. Keep snapshots bounded and
  replace them when the user changes the selected summaries.
- The idle timer must observe user prompts and agent activity, reset on either,
  and never delay session exit.
- MCP recovery and the project terminal remain later features, in the agreed
  priority order: summaries, MCP recovery, project terminal, session
  instructions.

## Open questions

- Confirm that custom session metadata written through `session.update` is
  visible to the server context hook in v2.2.7.
- Confirm the TUI slot suitable for a compact persistent summary indicator.
