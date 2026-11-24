/** @jsxImportSource @opentui/solid */
/**
 * opencode-status-line — a live usage-and-speed status line for OpenCode's CLI
 * prompt footer: context window, cache, streaming speed, cost, elapsed time
 * and uncommitted changes in one row, drawn in one UI slot or several at once
 * (`surface`) and configurable per segment (`usage.segments`, overridable per
 * placement through `usage.surfaces`).
 *
 * The speed segment carries two live readings. OpenCode only learns exact token
 * counts when a step settles — ends or fails — so the live figures are
 * estimated from streamed output (`session.text.delta`,
 * `session.reasoning.delta`, `session.tool.input.delta`) and calibrated
 * against the exact counts on `session.step.ended` and `session.step.failed`.
 * Reasoning and visible output keep separate characters-per-token ratios,
 * tool input counting as output; small steps accumulate until they teach
 * together:
 *
 *   sliding     ↯  what the last few seconds look like, right now
 *   cumulative  μ  the average since the turn began — exact tokens from every
 *                  finished step of the turn plus the step in flight; a queued
 *                  prompt starts its own turn, a steer stays in the current one
 *
 * The settled figure measures decode time: its span prefers the observed decode
 * clock, then the host's stream boundary (`session.step.streamed`, published
 * before tool settlement), so time a tool spent running is not charged. It
 * folds the whole turn (configurable) and the sliding reading comes to rest
 * once a stream stops — `window.hold: true` keeps it at a dimmed `0.0` over an
 * empty gauge, `false` hides it, `"last"` keeps the last value — so the line
 * keeps its shape without re-showing a figure nothing is producing. A session
 * met without a meter (a resume, a plugin reload) has its settled figure
 * rebuilt from the last turn's recorded messages, so the meter segment does not
 * come back blank — it shows the settled average over a resting `↯ 0.0` and an
 * empty gauge. The sliding window's samples are delta arrival times no record
 * keeps, so a real `↯` figure only returns with the next stream. The gauge
 * stays on screen while the sliding figure rests, figures are speed-coloured,
 * and `/opencode-status-line` shows the numbers behind them.
 *
 * Configuration lives in `~/.config/opencode/opencode-status-line.json` and a
 * project's `.opencode-status-line.json` — see config.ts. The plugin lives in
 * this checkout and is listed in cli.json by absolute path; no build step,
 * OpenCode transpiles the TSX on load and resolves the imports itself.
 */
import { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"
import { Buffer } from "node:buffer"
import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { contextBarWidth, loadConfig, rateOptions, resolvedPadding, segmentsFor, sharesHostRow, stackFor, type Config, type Surface, type UsageSegment } from "./config.ts"
import { diffDue, diffKey, diffParts, diffTotals, type DiffReading, type DiffStat, type StatusFile } from "./diff.ts"
import { createGuard } from "./guard.ts"
import { HOST_PALETTE, inkColor, resolvePalette } from "./palette.ts"
import type { DeltaSource, Delivery, Display, Meter } from "./rate.ts"
import {
  active,
  adoptMeter,
  beginStep,
  beginToolInput,
  beginTurn,
  createMeter,
  deliver,
  display,
  endStep,
  endToolInput,
  endTurn,
  failStep,
  firstTokenAt,
  formatRate,
  notePeak,
  observe,
  peakTps,
  recordedSteps,
  recordStreamed,
  restoreFinal,
  speedTone,
  tpsStats,
  USAGE_LABELS,
} from "./rate.ts"
import { cacheRuns, columnWidth, contextRuns, cutRuns, dimRuns, gaugeFor, hostRuns, joinedWidth, muted, wrapRows, type CapInput, type Run, type RunTone } from "./render.ts"
import { contextUsed, duration, money, shellsLabel, type TokenRecord } from "./format.ts"
import {
  SUMMARY_ATTACHMENT_METADATA_KEY,
  summaryPrompt,
  summaryTranscript,
  type SessionSummary,
  type SummaryAttachment,
} from "./summary.ts"
import {
  PENDING_INSTRUCTIONS_METADATA_KEY,
  SESSION_INSTRUCTIONS_METADATA_KEY,
  type InstructionSnapshot,
  type UserInstruction,
} from "./instructions.ts"
import { TOOL_INVENTORY_RPC } from "./tool-inventory-rpc.ts"

/** How often the line redraws while something is on screen. */
const TICK_MS = 250

/**
 * The per-session meters live on `globalThis`, not in `setup`. OpenCode
 * hot-reloads the plugin whenever a source file it imports is saved: this
 * module is re-imported and `setup` runs again with every module-scope value
 * reset. The process outlives the generation, so the meters ride on it —
 * readings, high-water marks, history and calibration all survive a save, and
 * the line keeps painting the last figures instead of going dark mid-turn
 * while the new generation finds its feet.
 */
const METERS = "__opencodeStatusLineMeters"

const sharedMeters = (): Map<string, Meter> => {
  const shared = globalThis as Record<string, unknown>
  const existing = shared[METERS]
  if (existing instanceof Map) return existing as Map<string, Meter>
  const meters = new Map<string, Meter>()
  shared[METERS] = meters
  return meters
}

/**
 * The delivery type of every enqueued inbox item, keyed by inbox ID, until it
 * is delivered or cancelled. Shared across generations like the meters: an
 * item can be queued before a source save and delivered after, and a lost type
 * would silently merge the queued prompt into the turn before it — the very
 * split this bookkeeping exists to make.
 */
const DELIVERIES = "__opencodeStatusLineDeliveries"

const sharedDeliveries = (): Map<string, Delivery> => {
  const shared = globalThis as Record<string, unknown>
  const existing = shared[DELIVERIES]
  if (existing instanceof Map) return existing as Map<string, Delivery>
  const deliveries = new Map<string, Delivery>()
  shared[DELIVERIES] = deliveries
  return deliveries
}

/** The host's delivery string as the known delivery type, when it is one. */
const asDelivery = (value: string | undefined): Delivery | undefined =>
  value === "steer" || value === "queue" ? value : undefined

/** The bits of the event payloads this plugin reads. */
interface Tokens {
  output?: number
  reasoning?: number
}

interface Event {
  type?: string
  created?: number
  data?: {
    sessionID?: string
    server?: string
    assistantMessageID?: string
    delta?: string
    tokens?: Tokens
    /** The inbox item an enqueue names; its `delivery` says how it will run. */
    item?: { delivery?: string }
    /** The inbox item an enqueue, delivery, change or cancel names. */
    inboxID?: string
    /** The delivery type a change reports. */
    delivery?: string
  }
}

/** The bits of a stored session message the meter seed reads. */
interface StoredMessage {
  type?: string
  id?: string
  time?: { created?: number; streamed?: number; completed?: number }
  content?: Array<{ type?: string; text?: string; time?: { created?: number; completed?: number } }>
  tokens?: { output?: number; reasoning?: number }
}

/** Where a session's working tree lives — the shells it runs, the VCS it is under. */
type SessionLocation = { directory?: string | null; workspaceID?: string }

export default Plugin.define({
  id: "opencode-status-line",
  setup(context) {
    const directory =
      context.location?.directory ?? context.data.location.default()?.directory ?? process.cwd()
    const loaded = loadConfig(directory, context.options)
    const config: Config = loaded.config
    const opts = rateOptions(config)
    const labels = USAGE_LABELS[config.labels]
    /**
     * The palette the line wears, when `colors.palette` picks one instead of
     * the host's tokens. A family name follows the host's resolved mode;
     * `context.themeMode` is that mode (`dark`/`light`), never `system`.
     */
    const palette =
      config.palette === HOST_PALETTE
        ? undefined
        : resolvePalette(config.palette, context.themeMode, config.toneOverrides)
    const contextWidth = contextBarWidth(config)
    for (const warning of loaded.warnings) {
      console.warn(`opencode-status-line: ${warning}`)
      context.ui.toast.show({ variant: "warning", title: "opencode-status-line", message: warning, duration: 10_000 })
    }

    const meters = sharedMeters()
    const deliveries = sharedDeliveries()
    // A hot reload can hand this generation meters saved before the class
    // ratios existed; adopt them rather than reading NaN estimates until the
    // stream restarts.
    for (const each of meters.values()) adoptMeter(each)
    const [version, setVersion] = createSignal(0, { equals: false })
    type SummaryState = { version: 1; entries: Record<string, SessionSummary> }
    const [summaryState, updateSummaryState] = context.storage.store<SummaryState>("session-summaries", {
      initial: { version: 1, entries: {} },
    })
    const [summaryStatus, setSummaryStatus] = createSignal("idle")
    const [mcpRecoveryCount, setMcpRecoveryCount] = createSignal(0)
    const [summarySectionOpen, setSummarySectionOpen] = createSignal(false)
    const [instructionSectionOpen, setInstructionSectionOpen] = createSignal(false)
    type ToolInventory = { tools: Array<{ id: string; description: string; schema: string; estimatedTokens: number }>; estimatedTokens: number }
    const [toolInventory, setToolInventory] = createSignal<ToolInventory>()
    const [toolInventoryLoading, setToolInventoryLoading] = createSignal(false)
    const [toolInventoryError, setToolInventoryError] = createSignal(false)
    type SummaryPickerState = { sessionID: string; entries: SessionSummary[] }
    type InstructionPickerState = { sessionID: string; entries: UserInstruction[]; mode: "always" | "slash" }
    const [summaryPicker, setSummaryPicker] = createSignal<SummaryPickerState>()
    const [summaryPickerCursor, setSummaryPickerCursor] = createSignal(0)
    const [selectedSummaryIDs, setSelectedSummaryIDs] = createSignal<string[]>([])
    let summaryDetailScroll: { scrollBy: (delta: number) => void; scrollTo: (position: number) => void } | undefined
    const [instructionPicker, setInstructionPicker] = createSignal<InstructionPickerState>()
    const [selectedInstructionIDs, setSelectedInstructionIDs] = createSignal<string[]>([])
    type InstructionLibraryState = { version: 1; items: UserInstruction[] }
    const [instructionLibrary, updateInstructionLibrary] = context.storage.store<InstructionLibraryState>("session-instructions", {
      initial: { version: 1, items: [] },
    })
    const summaryStatusText = () =>
      [
        mcpRecoveryCount() > 0 ? `MCP reconnecting (${mcpRecoveryCount()})` : undefined,
        summaryStatus() === "working" ? "Summarizing..." : summaryStatus() === "done" ? "Summary ready" : undefined,
      ]
        .filter(Boolean)
        .join(" | ")
    let timer: ReturnType<typeof setInterval> | undefined
    /** Keeps the elapsed timer and held figures repainting while nothing streams. */
    const heartbeat = setInterval(() => setVersion((value) => value + 1), 1_000)

    const bump = () => setVersion((value) => value + 1)

    const meter = (sessionID: string): Meter => {
      let existing = meters.get(sessionID)
      if (!existing) {
        existing = createMeter(opts)
        meters.set(sessionID, existing)
      }
      return existing
    }

    /** Redraw while anything is on screen, then stop; the next delta wakes it again. */
    const tick = () => {
      if (timer) return
      timer = setInterval(() => {
        bump()
        const now = Date.now()
        let alive = false
        for (const each of meters.values()) {
          // The gauge's upper bound only ever rises: every reading the line
          // shows while ticking feeds the session's high-water mark.
          const view = display(each, now, config.readings, opts)
          if (view) notePeak(each, view.primary)
          if (active(each, now, opts)) alive = true
        }
        if (alive) return
        clearInterval(timer)
        timer = undefined
      }, TICK_MS)
    }

    /**
     * A session can meet this generation with history: a plugin reload or TUI
     * restart lands on a turn already streaming, and a resume lands on one that
     * finished in a past process. Either way there is no meter, and the line
     * would show a blank meter segment while the other segments recompute from
     * the records. Rebuild what the records carry for a session without one:
     * the step in flight from its streaming message — so its exact figure still
     * has a step to settle against — or the finished turn's settled figure from
     * its completed assistant messages. The sliding window's samples are delta
     * arrival times no record keeps, so the window reading rests at zero rather
     * than being invented.
     *
     * Retried on later paints until the cache yields a foldable turn: at
     * startup the host may hold only the newest page of a long session, and a
     * tail without its user message is not a turn. `synced` forces the full
     * fetch once per session; `seeding` keeps concurrent attempts apart.
     */
    const synced = new Set<string>()
    const seeding = new Set<string>()
    const seedMeter = async (sessionID: string) => {
      if (seeding.has(sessionID)) return
      seeding.add(sessionID)
      try {
        // The usage line's cost, tokens and start time come from this record.
        void context.data.session.sync(sessionID).catch(() => {})
        // Live events may have produced state already; when they have, they
        // are newer than the record and the seed stands down. Only a step
        // record or a settled figure counts — a meter with neither is just
        // the first delta, and this seed is exactly what it still lacks.
        if (meters.get(sessionID)?.step || meters.get(sessionID)?.final) return
        // The host hydrates a session's messages page by page to draw it, so
        // the cache is not proof of the whole transcript. Force one full sync
        // per session; afterwards, a still-partial cache is waited out rather
        // than guessed at.
        if (!synced.has(sessionID)) {
          synced.add(sessionID)
          await context.data.session.message.sync(sessionID)
        }
        if (meters.get(sessionID)?.step || meters.get(sessionID)?.final) return
        const messages = context.data.session.message.list(sessionID) as StoredMessage[] | undefined
        let streaming: StoredMessage | undefined
        for (const message of messages ?? []) {
          if (message?.type === "assistant" && message.time?.completed === undefined) streaming = message
        }
        if (streaming?.id) {
          let outputChars = 0
          let reasoningChars = 0
          for (const part of streaming.content ?? []) {
            if (typeof part.text !== "string") continue
            if (part.type === "text") outputChars += part.text.length
            else if (part.type === "reasoning") reasoningChars += part.text.length
          }
          // The first reasoning timestamp is the closest thing to the first
          // token the record keeps; `time.streamed` is the stream boundary,
          // an end stamp, not a start.
          const at = firstTokenAt(streaming) ?? streaming.time?.created ?? Date.now()
          const each = meter(sessionID)
          each.step = {
            assistantMessageID: streaming.id,
            outputChars,
            reasoningChars,
            at,
            arrivedAt: Date.now(),
            tokenAt: at,
            tokenArrivedAt: Date.now(),
          }
          bump()
          return
        }
        // Nothing is streaming: settle the last turn from its record. With no
        // user message in hand the cache is still filling, so leave no meter —
        // the meter branch retries on a later paint — and show no figure
        // rather than a tail no process measured.
        const steps = recordedSteps(messages ?? [])
        if (!steps) return
        const each = meter(sessionID)
        if (restoreFinal(each, steps, Date.now(), opts) !== undefined) bump()
      } catch (error) {
        console.warn("opencode-status-line: could not seed the meter", error)
      } finally {
        seeding.delete(sessionID)
      }
    }
    const startup = context.ui.router.current()

    const onDelta = (source: DeltaSource) => (event: Event) => {
      const data = event?.data
      if (!data || typeof data.sessionID !== "string") return
      const { delta } = data
      if (typeof delta !== "string" || delta.length === 0) return
      // The event's own clock marks the first token, so the exact figure's span
      // starts when the model actually began emitting. The message ID
      // attributes the delta: a straggler from an earlier step must not be
      // charged to the step now streaming. The source keeps reasoning and
      // visible output on their own calibrated ratios.
      observe(meter(data.sessionID), Date.now(), delta.length, event.created, opts, data.assistantMessageID, source)
      tick()
    }

    const sessionOf = (event: Event): string | undefined =>
      typeof event?.data?.sessionID === "string" ? event.data.sessionID : undefined

    /**
     * A plugin bug must never take the interface down with it. An uncaught
     * exception inside an event handler can kill the plugin generation — that
     * is measured, not hypothetical: one half-saved file cost a TUI restart.
     * Handlers report and resume instead.
     */
    const safely = (handler: (event: Event) => void) => (event: Event) => {
      try {
        handler(event)
      } catch (error) {
        console.warn("opencode-status-line: handler failed", error)
      }
    }

    const onTurnEnd = (event: Event) => {
      const sessionID = sessionOf(event)
      if (!sessionID) return
      endTurn(meter(sessionID), Date.now(), opts)
      // The turn has just written to the working tree: mark the diff reading
      // stale, so the next paint re-asks rather than waiting out the interval.
      const reading = diffs.get(diffKey(sessionLocation(sessionID)))
      if (reading) reading.at = 0
      bump()
    }

    const stops = [
      context.data.on(
        "mcp.status.changed",
        safely((event: Event) => {
          const server = event?.data?.server
          if (typeof server === "string") {
            void handleMCPStatus(server).catch((error) =>
              console.warn("opencode-status-line: could not inspect MCP status", error),
            )
          }
        }),
      ),
      context.data.on("session.text.delta", safely(onDelta("text"))),
      context.data.on("session.reasoning.delta", safely(onDelta("reasoning"))),
      // Tool arguments stream as visible output tokens too; they count in the
      // output class, the host's own split, so a large file or command being
      // written keeps the meter honest without teaching the reasoning ratio.
      context.data.on("session.tool.input.delta", safely(onDelta("tool"))),
      // A tool call's argument stream. The host publishes the window's
      // boundaries even when it publishes no per-chunk deltas — this host and
      // provider stream none — and argument tokens are part of the step's
      // exact output, so the window is charged to the step's decode clock:
      // the opening boundary pauses ordinary gap accounting, the closing one
      // charges the window. Execution starts at `session.tool.called`, after
      // the closing boundary, so tool runtime still is not charged.
      context.data.on(
        "session.tool.input.started",
        safely((event: Event) => {
          const data = event?.data
          if (typeof data?.sessionID !== "string") return
          beginToolInput(meter(data.sessionID), data.assistantMessageID, Date.now())
        }),
      ),
      context.data.on(
        "session.tool.input.ended",
        safely((event: Event) => {
          const data = event?.data
          if (typeof data?.sessionID !== "string") return
          endToolInput(meter(data.sessionID), data.assistantMessageID, Date.now(), opts)
        }),
      ),
      context.data.on(
        "session.step.started",
        safely((event: Event) => {
          const data = event?.data
          if (typeof data?.sessionID !== "string" || typeof data?.assistantMessageID !== "string") return
          // The envelope's own clock for both ends of the step: the two events are
          // stamped by the same server, so the duration cannot mix clock domains.
          const started = typeof event.created === "number" && event.created > 0 ? event.created : Date.now()
          beginStep(meter(data.sessionID), data.assistantMessageID, started, Date.now())
        }),
      ),
      context.data.on(
        "session.step.streamed",
        safely((event: Event) => {
          const data = event?.data
          if (typeof data?.sessionID !== "string" || typeof data?.assistantMessageID !== "string") return
          // The provider response body ended here, before any tool it called
          // settled. The host stamps `time.streamed` with the event's own
          // clock, so only that stamp is comparable with the first-token one;
          // a missing stamp leaves the step unstamped rather than mixing in a
          // local clock the settlement span cannot use.
          if (typeof event.created !== "number" || event.created <= 0) return
          recordStreamed(meter(data.sessionID), data.assistantMessageID, event.created)
        }),
      ),
      context.data.on(
        "session.step.ended",
        safely((event: Event) => {
          const data = event?.data
          const tokens = data?.tokens
          if (typeof data?.sessionID !== "string" || typeof data?.assistantMessageID !== "string" || !tokens) return
          const endedAt = typeof event.created === "number" && event.created > 0 ? event.created : Date.now()
          endStep(meter(data.sessionID), data.assistantMessageID, tokens, endedAt, Date.now(), opts)
          bump()
        }),
      ),
      context.data.on(
        "session.step.failed",
        safely((event: Event) => {
          const data = event?.data
          if (typeof data?.sessionID !== "string" || typeof data?.assistantMessageID !== "string") return
          // A failure settles the matching step on the spot: the exact tokens
          // the event reports fold in, and a failure without them simply
          // clears, so the step does not linger decaying until turn end. The
          // same clock domain as the started and ended stamps.
          const tokens = data.tokens ?? {}
          const endedAt = typeof event.created === "number" && event.created > 0 ? event.created : Date.now()
          failStep(meter(data.sessionID), data.assistantMessageID, tokens, endedAt, Date.now(), opts)
          bump()
        }),
      ),
      // Turn boundaries: a prompt starts an execution, and its settlement ends
      // it; a queued prompt's delivery (below) is the boundary a single
      // busy-period `session.execution.started` cannot draw. The fold resets at
      // those points alone — a steer is deliberately not a boundary.
      context.data.on(
        "session.execution.started",
        safely((event: Event) => {
          const sessionID = sessionOf(event)
          if (!sessionID) return
          cancelSummaryTimer(sessionID)
          beginTurn(meter(sessionID), Date.now(), opts)
        }),
      ),
      context.data.on("session.execution.succeeded", safely(onTurnEnd)),
      context.data.on("session.execution.failed", safely(onTurnEnd)),
      context.data.on("session.execution.interrupted", safely(onTurnEnd)),
      // A late belt for a turn whose execution settlement never arrived: idle
      // closes the fold too, and a second close is a no-op. Without it a turn
      // that ended quietly would bleed into the next one's cumulative figure.
      context.data.on(
        "session.idle",
        safely((event: Event) => {
          onTurnEnd(event)
          const sessionID = sessionOf(event)
          if (sessionID) {
            scheduleIdleSummary(sessionID)
            void clearPendingInstructions(sessionID).catch((error) =>
              console.warn("opencode-status-line: could not clear one-prompt instructions", error),
            )
          }
        }),
      ),
      // A queued prompt is a turn boundary of its own: one execution busy
      // period publishes a single `session.execution.started`, so the host can
      // process several queued prompts under one begin/end pair. Each item's
      // delivery type is remembered from its enqueue — and kept current if it
      // changes while it waits — so a queued delivery can close the fold and
      // start a fresh one, giving every prompt its own average. A steer leaves
      // the fold alone, and an item queued before this generation loaded (its
      // type was never seen) reads as a steer rather than splitting a turn on
      // a guess. `deliver` reuses the turn-close semantics.
      context.data.on(
        "session.inbox.enqueued",
        safely((event: Event) => {
          const data = event?.data
          if (typeof data?.inboxID !== "string") return
          const delivery = asDelivery(data.item?.delivery)
          if (delivery) deliveries.set(data.inboxID, delivery)
        }),
      ),
      context.data.on(
        "session.inbox.delivery.changed",
        safely((event: Event) => {
          const data = event?.data
          if (typeof data?.inboxID !== "string") return
          const delivery = asDelivery(data.delivery)
          if (delivery) deliveries.set(data.inboxID, delivery)
        }),
      ),
      context.data.on(
        "session.inbox.delivered",
        safely((event: Event) => {
          const data = event?.data
          if (typeof data?.inboxID !== "string") return
          const delivery = deliveries.get(data.inboxID)
          // The item left the inbox whether or not this generation can use it.
          deliveries.delete(data.inboxID)
          if (typeof data?.sessionID !== "string") return
          deliver(meter(data.sessionID), delivery, Date.now(), opts)
          bump()
        }),
      ),
      context.data.on(
        "session.inbox.cancelled",
        safely((event: Event) => {
          const data = event?.data
          if (typeof data?.inboxID === "string") deliveries.delete(data.inboxID)
        }),
      ),
      // Cost, tokens and the context window live on the session record; any
      // update to it should repaint the usage line.
      context.data.on("session.usage.updated", safely(() => bump())),
      context.data.on("session.model.selected", safely(() => bump())),
    ]

    /**
     * The guards that keep a throwing step from costing the line. Each one owns
     * one kind of draw step, so a failure in the colours cannot latch the tree
     * away and vice versa; see guard.ts for the policy and why the latch is
     * what stops a broken install from leaking the host's native handles.
     *
     * `inkGuard` covers everything the colourizer touches — the palette, the
     * tone overrides and the host's theme tokens — which is the step most
     * likely to fail when the plugin and the host do not share a runtime. Its
     * fallback is the renderer's own ink: the text still draws.
     */
    const inkGuard = createGuard({ label: "the colours" })
    const segmentGuard = createGuard({ label: "a segment" })

    /**
     * A run's colour: the tone at full strength while live, muted once
     * settled. With `colors.enabled` off, tones are ignored and the line
     * takes the body and muted inks alone. A run marked `host` — its segment
     * is excluded from the palette — draws from the OpenCode theme instead,
     * overrides and all.
     *
     * A colourizer that throws costs the line its colour, not its text: an
     * uncoloured line is still a line, and a missing one is not.
     */
    const toneColor = (tone: RunTone | undefined, muted: boolean, host = false): string | undefined =>
      inkGuard.attempt(
        () =>
          host
            ? inkColor(config.colors ? tone : undefined, muted, undefined, {}, context.theme.text)
            : inkColor(config.colors ? tone : undefined, muted, palette, config.toneOverrides, context.theme.text),
        () => undefined,
      )

    /** Settings for the gauge: the session's high-water mark sets its scale. */
    const capInput = (view: Display, each: Meter): CapInput => ({
      style: config.capMode,
      primary: view.primary,
      peak: peakTps(each),
      gaugeWidth: config.gaugeWidth,
      gaugeFloor: config.gaugeFloor,
      fast: config.fastTps,
      slow: config.slowTps,
    })

    const currentSession = (): string | undefined => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    const openProjectPowerShell = () => {
      const sessionID = currentSession()
      const session = sessionID ? context.data.session.get(sessionID) : undefined
      const directory = session?.location.directory ?? context.location?.directory ?? context.data.location.default()?.directory
      if (!directory) {
        context.ui.toast.show({ variant: "warning", message: "Open a project before launching PowerShell." })
        return
      }
      const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`
      const childCommand = `Set-Location -LiteralPath ${psQuote(directory)}`
      // `start` creates a visible console window. Launching a hidden PowerShell
      // process that itself calls Start-Process can silently leave the user with
      // only the success toast on Windows Terminal hosts.
      const encodedCommand = Buffer.from(childCommand, "utf16le").toString("base64")
      try {
        const launcher = spawn("cmd.exe", ["/d", "/c", "start", "", "powershell.exe", "-NoLogo", "-NoExit", "-EncodedCommand", encodedCommand], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        })
        launcher.once("error", (error) => {
          try {
            context.ui.toast.show({ variant: "error", title: "Could not open PowerShell", message: error.message })
          } catch (toastError) {
            console.warn("opencode-status-line: PowerShell launch notification failed", toastError)
          }
        })
        launcher.once("spawn", () => {
          launcher.unref()
          context.ui.toast.show({ variant: "info", title: "PowerShell opened", message: directory })
        })
      } catch (error) {
        context.ui.toast.show({
          variant: "error",
          title: "Could not open PowerShell",
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const attachSummarySelection = async (): Promise<void> => {
      const picker = summaryPicker()
      const chosenIDs = selectedSummaryIDs().length
        ? selectedSummaryIDs()
        : picker?.entries[summaryPickerCursor()]
          ? [picker.entries[summaryPickerCursor()].sessionID]
          : []
      const selectedEntries = chosenIDs
        .map((id) => summaryState.entries[id] ?? picker?.entries.find((entry) => entry.sessionID === id))
        .filter((entry): entry is SessionSummary => Boolean(entry))
      if (!picker || !selectedEntries.length) {
        context.ui.toast.show({ variant: "warning", message: "There are no summaries to attach." })
        return
      }
      const activeInfo = context.data.session.get(picker.sessionID)
      if (!activeInfo) return
      const attachments: SummaryAttachment[] = selectedEntries.map(({ sessionID, projectID, title, summary, updatedAt }) => ({
        sessionID,
        projectID,
        title,
        summary,
        updatedAt,
      }))
      await context.client.session.update({
        sessionID: picker.sessionID,
        metadata: { ...activeInfo.metadata, [SUMMARY_ATTACHMENT_METADATA_KEY]: attachments },
      })
      setSummaryPicker(undefined)
      context.ui.dialog.clear()
      context.ui.toast.show({ variant: "success", message: `${attachments.length} summary context(s) attached to this session.` })
    }

    const validInstructionSnapshots = (value: unknown): InstructionSnapshot[] =>
      Array.isArray(value)
        ? value.filter((entry): entry is InstructionSnapshot => {
            if (!entry || typeof entry !== "object") return false
            const item = entry as Record<string, unknown>
            return (
              typeof item.id === "string" &&
              typeof item.title === "string" &&
              typeof item.prompt === "string" &&
              (item.mode === "always" || item.mode === "slash")
            )
          })
        : []

    const attachInstructionSelection = async (): Promise<void> => {
      const picker = instructionPicker()
      if (!picker) return
      const selected = selectedInstructionIDs()
        .map((id) => instructionLibrary.items.find((item) => item.id === id) ?? picker.entries.find((item) => item.id === id))
        .filter((item): item is UserInstruction => Boolean(item))
        .map(({ id, title, prompt, mode }) => ({ id, title, prompt, mode }))
      const activeInfo = context.data.session.get(picker.sessionID)
      if (!activeInfo) return
      const key = picker.mode === "always" ? SESSION_INSTRUCTIONS_METADATA_KEY : PENDING_INSTRUCTIONS_METADATA_KEY
      if (!selected.length) {
        await context.client.session.update({
          sessionID: picker.sessionID,
          metadata: { ...activeInfo.metadata, [key]: [] },
        })
        setInstructionPicker(undefined)
        context.ui.dialog.clear()
        context.ui.toast.show({
          variant: "info",
          message: picker.mode === "always" ? "Always-active instructions cleared for this session." : "Queued instructions cleared.",
        })
        return
      }
      const metadata = activeInfo.metadata as Record<string, unknown> | undefined
      const existing = picker.mode === "slash" ? validInstructionSnapshots(metadata?.[key]) : []
      const combined = [...new Map([...existing, ...selected].map((item) => [item.id, item])).values()]
      await context.client.session.update({
        sessionID: picker.sessionID,
        metadata: { ...activeInfo.metadata, [key]: combined },
      })
      setInstructionPicker(undefined)
      context.ui.dialog.clear()
      context.ui.toast.show({
        variant: "success",
        message:
          picker.mode === "always"
            ? `${selected.length} instruction(s) attached to this session.`
            : `${selected.length} instruction(s) queued for the next prompt.`,
      })
    }

    const clearPendingInstructions = async (sessionID: string): Promise<void> => {
      const session = context.data.session.get(sessionID)
      if (!session) return
      const metadata = session.metadata as Record<string, unknown> | undefined
      if (!validInstructionSnapshots(metadata?.[PENDING_INSTRUCTIONS_METADATA_KEY]).length) return
      await context.client.session.update({
        sessionID,
        metadata: { ...session.metadata, [PENDING_INSTRUCTIONS_METADATA_KEY]: [] },
      })
    }

    const SummaryPicker = () => (
      <Show when={summaryPicker()}>
        {(state) => (
          <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
            <text>Up/Down browse | Space select/deselect | PgUp/PgDn scroll details | Enter attach | Esc cancel</text>
            <Show when={state().entries.length === 1}>
              <text>Only one summary is saved. Create summaries in other sessions with /summary to add choices.</text>
            </Show>
            <box flexDirection="column" border borderStyle="single" title="Saved summaries" paddingLeft={1} paddingRight={1}>
              <For each={state().entries}>
                {(entry, index) => (
                  <text wrapMode="none">
                    {index() === summaryPickerCursor() ? "> " : "  "}
                    {selectedSummaryIDs().includes(entry.sessionID) ? "[x] " : "[ ] "}
                    {entry.title}
                  </text>
                )}
              </For>
            </box>
            <Show when={state().entries[summaryPickerCursor()]}>
              {(entry) => (
                <box flexDirection="column" border borderStyle="single" title="Selected summary - full details" paddingLeft={1} paddingRight={1}>
                  <text wrapMode="none">{entry().title} | Updated {new Date(entry().updatedAt).toLocaleString("id-ID")}</text>
                  <scrollbox height={18} ref={(el) => { summaryDetailScroll = el }}>
                    <text>{entry().summary}</text>
                  </scrollbox>
                </box>
              )}
            </Show>
            <text>{selectedSummaryIDs().length || (state().entries.length ? 1 : 0)} selected | Enter attaches the highlighted item if none are checked</text>
          </box>
        )}
      </Show>
    )

    const InstructionPicker = () => (
      <Show when={instructionPicker()}>
        {(state) => (
          <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
            <text>
              {state().mode === "always"
                ? "Choose instructions for every prompt in this session."
                : "Choose instructions to apply to the next prompt only."}
              {" Use Space to select, Enter to apply, and Esc to cancel."}
            </text>
            <For each={state().entries}>
              {(entry, index) => (
                <box flexDirection="column" paddingTop={index() === summaryPickerCursor() ? 1 : 0}>
                  <text wrapMode="none">
                    {index() === summaryPickerCursor() ? "› " : "  "}
                    {selectedInstructionIDs().includes(entry.id) ? "[x] " : "[ ] "}
                    {entry.title}
                  </text>
                  <Show when={index() === summaryPickerCursor()}>
                    <text>{entry.prompt}</text>
                  </Show>
                </box>
              )}
            </For>
            <text>{selectedInstructionIDs().length} selected</text>
          </box>
        )}
      </Show>
    )

    const openInstructionPicker = (mode: "always" | "slash") => {
      const sessionID = currentSession()
      if (!sessionID) {
        context.ui.toast.show({ variant: "warning", message: "Open a session before choosing instructions." })
        return
      }
      const session = context.data.session.get(sessionID)
      const metadata = session?.metadata as Record<string, unknown> | undefined
      const key = mode === "always" ? SESSION_INSTRUCTIONS_METADATA_KEY : PENDING_INSTRUCTIONS_METADATA_KEY
      const selected = validInstructionSnapshots(metadata?.[key])
      const enabledItems = instructionLibrary.items.filter((item) => item.enabled && item.mode === mode)
      const previous = selected.map((snapshot) => instructionLibrary.items.find((item) => item.id === snapshot.id) ?? {
        ...snapshot,
        enabled: false,
        createdAt: 0,
      })
      const ids = new Set(enabledItems.map((item) => item.id))
      const entries = [...enabledItems, ...previous.filter((item) => !ids.has(item.id))]
      if (!entries.length) {
        context.ui.toast.show({
          variant: "info",
          message: mode === "always" ? "No always-active instructions. Use /instruction-add first." : "No slash-triggered instructions. Use /instruction-add first.",
        })
        return
      }
      setSummaryPicker(undefined)
      setSummaryPickerCursor(0)
      setInstructionPicker({ sessionID, entries, mode })
      setSelectedInstructionIDs(selected.map((item) => item.id))
      context.ui.dialog.set({ size: "xlarge" })
      context.ui.dialog.show(() => <InstructionPicker />)
    }

    const addInstruction = async () => {
      const title = (await context.ui.dialog.prompt({ title: "New instruction", placeholder: "Short name" }))?.trim()
      if (!title) return
      const prompt = (await context.ui.dialog.prompt({
        title: "Instruction text",
        description: "What should the agent do? This is stored in your local OpenCode plugin data.",
        placeholder: "Write the instruction",
      }))?.trim()
      if (!prompt) return
      const mode = await context.ui.dialog.select({
        title: "When should this instruction apply?",
        options: [
          { title: "Always in selected sessions", value: "always" as const },
          { title: "Only when triggered with /instruction", value: "slash" as const },
        ],
      })
      if (!mode) return
      const item: UserInstruction = {
        id: crypto.randomUUID(),
        title,
        prompt,
        mode,
        enabled: true,
        createdAt: Date.now(),
      }
      await updateInstructionLibrary((draft) => {
        draft.items.push(item)
      })
      context.ui.toast.show({ variant: "success", message: `Saved instruction: ${title}` })
    }

    const toggleInstruction = async () => {
      const item = await context.ui.dialog.select({
        title: "Enable or disable an instruction",
        options: instructionLibrary.items.map((entry) => ({
          title: `${entry.enabled ? "Enabled" : "Disabled"} · ${entry.title}`,
          description: entry.mode === "always" ? "Always-active" : "Slash-triggered",
          value: entry.id,
        })),
      })
      if (!item) return
      let enabled = false
      await updateInstructionLibrary((draft) => {
        const entry = draft.items.find((candidate) => candidate.id === item)
        if (!entry) return
        entry.enabled = !entry.enabled
        enabled = entry.enabled
      })
      context.ui.toast.show({ variant: "info", message: `${enabled ? "Enabled" : "Disabled"} instruction.` })
    }

    const deleteInstruction = async () => {
      const item = await context.ui.dialog.select({
        title: "Delete an instruction",
        options: instructionLibrary.items.map((entry) => ({ title: entry.title, description: entry.prompt, value: entry.id })),
      })
      if (!item) return
      const entry = instructionLibrary.items.find((candidate) => candidate.id === item)
      if (!entry) return
      const confirmed = await context.ui.dialog.confirm({
        title: "Delete instruction?",
        message: `Delete “${entry.title}” from your instruction library? Existing sessions keep their saved copy.`,
      })
      if (!confirmed) return
      await updateInstructionLibrary((draft) => {
        draft.items = draft.items.filter((candidate) => candidate.id !== item)
      })
      context.ui.toast.show({ variant: "success", message: `Deleted instruction: ${entry.title}` })
    }

    const generateSummary = async (sessionID: string, automatic = false): Promise<void> => {
      if (context.data.session.status(sessionID) === "running") return
      const session = context.data.session.get(sessionID)
      if (!session) return
      const existing = summaryState.entries[sessionID]
      if (automatic && existing && existing.sourceUpdatedAt >= session.time.updated) return
      setSummaryStatus("working")
      bump()
      try {
        await context.data.session.message.sync(sessionID)
        const messages = context.data.session.message.list(sessionID) ?? []
        const transcript = summaryTranscript(messages as Array<{ type?: string; text?: string; content?: Array<{ type?: string; text?: string }> }>)
        if (!transcript.trim()) throw new Error("This session has no conversation text to summarize.")
        const sourceUpdatedAt = context.data.session.get(sessionID)?.time.updated ?? session.time.updated
        const model = context.ui.model.current()
        const result = await context.client.generate.text({
          prompt: summaryPrompt(session.title ?? "Untitled session", transcript),
          model: model ? { id: model.modelID, providerID: model.providerID } : undefined,
        })
        const entry: SessionSummary = {
          sessionID,
          projectID: session.projectID,
          title: session.title ?? "Untitled session",
          summary: result.text.trim(),
          updatedAt: Date.now(),
          sourceUpdatedAt,
        }
        await updateSummaryState((draft) => {
          draft.entries[sessionID] = entry
        })
        setSummaryStatus("done")
        bump()
        if (!automatic) {
          context.ui.dialog.set({ size: "large" })
          context.ui.dialog.show(() => (
            <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
              <text>{entry.title}</text>
              <text>{entry.summary}</text>
            </box>
          ))
        }
      } catch (error) {
        setSummaryStatus("failed")
        context.ui.toast.show({
          variant: "error",
          title: "Session summary failed",
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        bump()
      }
    }

    const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const cancelSummaryTimer = (sessionID: string) => {
      const timer = idleTimers.get(sessionID)
      if (timer) clearTimeout(timer)
      idleTimers.delete(sessionID)
    }
    const scheduleIdleSummary = (sessionID: string) => {
      cancelSummaryTimer(sessionID)
      const timer = setTimeout(() => {
        idleTimers.delete(sessionID)
        if (context.data.session.status(sessionID) === "idle") void generateSummary(sessionID, true)
      }, 5 * 60_000)
      idleTimers.set(sessionID, timer)
    }

    type MCPConnection = { name: string; status: { status: string; error?: string } }
    type MCPRetry = { attempt: number; timer?: ReturnType<typeof setTimeout> }
    const MCP_RETRY_DELAYS = [2_000, 5_000, 15_000]
    const mcpRetries = new Map<string, MCPRetry>()
    const mcpExhausted = new Set<string>()
    let mcpRecoveryDisposed = false
    const mcpLocation = context.location?.directory ? { directory: context.location.directory } : undefined
    const listMCPConnections = async (): Promise<MCPConnection[]> => {
      const result = await context.client.mcp.list({ location: mcpLocation })
      return result.data as MCPConnection[]
    }
    const clearMCPRetry = (name: string) => {
      const retry = mcpRetries.get(name)
      if (retry?.timer) clearTimeout(retry.timer)
      mcpRetries.delete(name)
      setMcpRecoveryCount(mcpRetries.size)
    }
    const scheduleMCPRetry = (name: string) => {
      if (mcpRecoveryDisposed || mcpExhausted.has(name)) return
      const retry = mcpRetries.get(name) ?? { attempt: 0 }
      if (retry.attempt >= MCP_RETRY_DELAYS.length) {
        clearMCPRetry(name)
        mcpExhausted.add(name)
        context.ui.toast.show({
          variant: "warning",
          title: `MCP ${name} did not reconnect`,
          message: "Automatic retries stopped. Reconnect it from /mcp when ready.",
        })
        return
      }
      if (retry.timer) return
      retry.timer = setTimeout(() => {
        retry.timer = undefined
        void (async () => {
          try {
            const before = (await listMCPConnections()).find((server) => server.name === name)
            if (!before || before.status.status !== "failed") {
              if (before?.status.status !== "pending") clearMCPRetry(name)
              return
            }
            retry.attempt += 1
            try {
              await context.client.mcp.connect({ server: name, location: mcpLocation })
            } catch {
              // Inspect the server's current state below; a connect failure is
              // expected while a remote service is still recovering.
            }
            const after = (await listMCPConnections()).find((server) => server.name === name)
            if (after?.status.status === "connected") {
              mcpExhausted.delete(name)
              clearMCPRetry(name)
              context.ui.toast.show({ variant: "success", title: `MCP ${name} reconnected`, message: "The server is ready to use." })
              return
            }
            if (after?.status.status === "failed") {
              scheduleMCPRetry(name)
              return
            }
            if (after?.status.status !== "pending") clearMCPRetry(name)
          } catch {
            retry.attempt += 1
            scheduleMCPRetry(name)
          }
        })()
      }, MCP_RETRY_DELAYS[retry.attempt])
      mcpRetries.set(name, retry)
      setMcpRecoveryCount(mcpRetries.size)
    }
    const handleMCPStatus = async (name: string) => {
      if (mcpRecoveryDisposed) return
      const server = (await listMCPConnections()).find((entry) => entry.name === name)
      switch (server?.status.status) {
        case "failed":
          scheduleMCPRetry(name)
          break
        case "pending": {
          // A retry itself passes through pending. Keep its attempt counter
          // across that transition so repeated failures reach the circuit
          // breaker instead of restarting forever at the first delay.
          const retry = mcpRetries.get(name)
          if (retry?.timer) {
            clearTimeout(retry.timer)
            retry.timer = undefined
          }
          break
        }
        case "connected":
        case "disabled":
        case "needs_auth":
        case undefined:
          mcpExhausted.delete(name)
          clearMCPRetry(name)
          break
      }
    }
    if (startup.type === "session") {
      void seedMeter(startup.sessionID)
    }
    void listMCPConnections()
      .then((servers) => servers.filter((server) => server.status.status === "failed").forEach((server) => scheduleMCPRetry(server.name)))
      .catch((error) => console.warn("opencode-status-line: could not inspect MCP connections", error))

    /** What the session record carries for the usage line, read defensively. */
    interface SessionUsage {
      cost?: number
      tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
      model?: { id?: string; providerID?: string }
      time?: { created?: number }
      location?: { directory?: string | null }
    }

    const sessionUsage = (sessionID: string): SessionUsage | undefined =>
      context.data.session.get(sessionID) as SessionUsage | undefined

    /**
     * The window's occupant: the newest assistant message that has reported
     * usage. The session record's token totals are cumulative across turns —
     * summing them would report every prompt ever sent — so the context and
     * cache segments read the last request's own record instead.
     */
    const windowInfo = (
      sessionID: string,
    ): { tokens?: TokenRecord; model?: { id?: string; providerID?: string } } => {
      const messages = context.data.session.message.list(sessionID) as
        | Array<{ type?: string; tokens?: TokenRecord; model?: { id?: string; providerID?: string } }>
        | undefined
      let found: { tokens?: TokenRecord; model?: { id?: string; providerID?: string } } = {}
      for (const message of messages ?? []) {
        if (message?.type !== "assistant" || !message.tokens) continue
        if (contextUsed(message.tokens) > 0) found = { tokens: message.tokens, model: message.model }
      }
      return found
    }

    /** The model's declared context window, where the catalogue declares one. */
    const contextLimit = (model: { id?: string; providerID?: string } | undefined): number | undefined => {
      if (!model?.id || !model.providerID) return undefined
      const location = context.location ?? context.data.location.default()
      for (const entry of context.data.location.model.list(location) ?? []) {
        const info = entry as { id?: string; providerID?: string; limit?: { context?: number } }
        if (info?.id === model.id && info.providerID === model.providerID) {
          const limit = info.limit?.context
          return typeof limit === "number" && limit > 0 ? limit : undefined
        }
      }
      return undefined
    }

    /** The location a session's shells and working tree live at; the session record knows best. */
    const sessionLocation = (sessionID: string): SessionLocation =>
      sessionUsage(sessionID)?.location ?? context.location ?? context.data.location.default()

    /**
     * Shells the host is running for this session. `data.shell` holds a shell
     * only while it executes — background shells live in a separate registry —
     * so this reads as live activity.
     */
    const shellRuns = (sessionID: string): Run[] => {
      // The shell registry keys on a concrete directory; a session record may
      // not carry one, and `undefined` asks the host for the current location.
      const location = sessionLocation(sessionID)
      const ref = location.directory
        ? { directory: location.directory, workspaceID: location.workspaceID }
        : undefined
      const running = (context.data.shell.list(ref) ?? [])
        .filter((shell) => shell.status === "running" && shell.metadata?.sessionID === sessionID)
      return running.length > 0 ? [{ ...muted(shellsLabel(running.length)), onClick: openShells }] : []
    }

    /**
     * Toggle the composer through the host command, whose Shell tab lists
     * running shells and opens the host's own output viewer. Dispatch the
     * command rather than imitating the popup, so the UI is the host's own.
     */
    const openShells = () => context.keymap.dispatch("session.child.first")

    /**
     * The diff segment's readings, keyed by location. The host answers each
     * request from scratch — a working-copy status listing with a diff behind
     * it — so the counter is cached and re-asked on an interval rather than on
     * every repaint, and a closing turn marks the reading stale so the next
     * paint reflects what the turn just wrote.
     */
    const diffs = new Map<string, DiffReading>()
    const diffing = new Set<string>()

    const refreshDiff = (key: string, location: SessionLocation) => {
      if (diffing.has(key)) return
      const vcs = context.client?.vcs as
        | { status?: (input: { location?: SessionLocation }) => Promise<{ data?: StatusFile[] } | undefined> }
        | undefined
      if (typeof vcs?.status !== "function") return
      diffing.add(key)
      try {
        void vcs
          .status({ location })
          .then(
            (result) => diffs.set(key, { stat: diffTotals(result?.data), at: Date.now() }),
            () => {
              // No repository, no provider, or a host too busy: a location
              // that cannot answer reads as a clean tree until the interval.
              diffs.set(key, { stat: { added: 0, deleted: 0 }, at: Date.now() })
            },
          )
          .finally(() => {
            diffing.delete(key)
            bump()
          })
      } catch {
        // A host without the VCS surface: leave the segment dark.
        diffing.delete(key)
      }
    }

    /** The `+12 -3` counter: additions green, deletions red, a clean tree silent. */
    const diffRuns = (stat: DiffStat): Run[] => {
      const runs: Run[] = []
      for (const [index, part] of diffParts(stat).entries()) {
        if (index > 0) runs.push(muted(" "))
        runs.push({ text: part.text, tone: part.side === "added" ? "success" : "error" })
      }
      return runs
    }

    const meterRuns = (view: Display, each: Meter): Run[] => {
      const runs = gaugeFor(capInput(view, each))
      view.readings.forEach((reading, index) => {
        const lead = index > 0 ? " · " : runs.length > 0 ? " " : ""
        runs.push({
          text: `${lead}${reading.label} ${formatRate(reading.tps)}`,
          tone: speedTone(reading.tps, config.fastTps, config.slowTps),
          dim: !reading.live,
        })
      })
      runs.push(muted(" tok/s"))
      return runs
    }

    const costRuns = (usage: SessionUsage | undefined): Run[] => {
      const cost = usage?.cost
      return typeof cost === "number" && cost > 0 ? [muted(money(cost))] : []
    }

    const timeRuns = (usage: SessionUsage | undefined, now: number): Run[] => {
      const created = usage?.time?.created
      return typeof created === "number" && created > 0 ? [muted(duration(now - created))] : []
    }

    /**
     * The given segments in their configured order, each as its own run list;
     * a segment with nothing to say is skipped. The list is the placement's —
     * `usage.surfaces` may differ from surface to surface — and how the rows
     * meet is that surface's business: joined across for a footer, one per row
     * for a sidebar.
     */
    const usageRows = (segments: UsageSegment[], sessionID: string, now: number): Run[][] => {
      const session = sessionUsage(sessionID)
      const window = windowInfo(sessionID)
      const limit = contextLimit(window.model ?? session?.model)

      /** One segment's runs, before the exclusion mark. */
      const partFor = (segment: UsageSegment): Run[] => {
        if (segment === "shells") return shellRuns(sessionID)
        if (segment === "context") {
          return contextRuns({
            tokens: window.tokens,
            limit,
            width: contextWidth,
            warnAt: config.contextWarn,
            dangerAt: config.contextDanger,
          })
        }
        if (segment === "cache") return cacheRuns(window.tokens, labels.cache)
        if (segment === "meter") {
          const found = meters.get(sessionID)
          // A session with no meter has met this generation mid-history — a
          // resume, a reload: rebuild its last figure from the records. The
          // seed repaints when it lands; this paint shows the other segments.
          if (!found) void seedMeter(sessionID)
          const view = found ? display(found, now, config.readings, opts, labels) : undefined
          return found && view ? meterRuns(view, found) : []
        }
        if (segment === "cost") return costRuns(session)
        if (segment === "time") return timeRuns(session, now)
        if (segment === "diff") {
          const location = sessionLocation(sessionID)
          const key = diffKey(location)
          const reading = diffs.get(key)
          if (diffDue(reading, now, config.diffRefreshMs)) refreshDiff(key, location)
          return reading ? diffRuns(reading.stat) : []
        }
        return []
      }

      const rows: Run[][] = []
      let drawn = 0
      let lost = 0
      for (const segment of segments) {
        // A segment that throws costs that segment alone: the rest of the line
        // is still worth drawing, and a bug in the shells count must not take
        // the speed meter down with it.
        let failed = false
        const part = segmentGuard.attempt(
          () => partFor(segment),
          () => {
            failed = true
            return []
          },
        )
        if (failed) lost += 1
        if (part.length === 0) continue
        drawn += 1
        // An excluded segment always draws in the host theme: mark its runs
        // before they reach the colourizer.
        rows.push(config.excludeSegments.includes(segment) ? hostRuns(part) : part)
      }
      // Every segment failed — a host API the line depends on is gone, not one
      // reading that has yet to arrive. Draw the failure rather than nothing:
      // a line that admits something is wrong beats a line that vanishes.
      if (drawn === 0 && lost > 0) rows.push([{ text: "⚠", tone: "muted" }])
      return rows
    }

    /** The rows joined across one line, separators between. */
    const joinRows = (rows: Run[][]): Run[] => {
      const runs: Run[] = []
      for (const row of rows) {
        if (runs.length > 0) runs.push(muted(config.usageSeparator))
        runs.push(...row)
      }
      return runs
    }

    const Stats = (props: { sessionID?: string }) => {
      const each = () => {
        version()
        return props.sessionID ? meters.get(props.sessionID) : undefined
      }
      const stats = createMemo(() => {
        const found = each()
        return found ? tpsStats(found, Date.now(), config.statsWindowMs) : undefined
      })
      const view = createMemo(() => {
        const found = each()
        return found ? display(found, Date.now(), config.readings, opts, labels) : undefined
      })
      return (
        <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
          <text>tok/s</text>
          <text>
            {view()
              ? `${view()!.readings.map((reading) => `${reading.label} ${formatRate(reading.tps)}`).join(" · ")} tok/s`
              : "idle"}
          </text>
          <text>
            {stats() && stats()!.count > 0
              ? `avg ${Math.round(config.statsWindowMs / 1000)}s ${formatRate(stats()!.avg)} · mean ${formatRate(stats()!.mean)} · p95 ${formatRate(stats()!.p95)} (unweighted per turn) · ${stats()!.count} turns`
              : "no completed turns yet"}
          </text>
        </box>
      )
    }

    /**
     * The stats command.
     *
     * v2 keeps the keymap provider inside its component tree, so a layer
     * registered from `setup` throws "Keymap.Provider is missing" and takes the
     * whole plugin down with it. The `app` slot's render runs inside that tree,
     * once, and owns the layer from there (the pattern the CLI plugin docs use).
     *
     * The layer must be `mode: "global"`. v2 pushes `autocomplete` while the
     * slash list is open and `modal` while a dialog is, and a layer that names
     * no mode is pinned to `base`, which disables it in exactly the two places
     * a command is looked for. Mode-less commands therefore never appear.
     */
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "opencode-status-line.stats",
              title: "Speed: statistics",
              group: "opencode-status-line",
              palette: true,
              slash: { name: "opencode-status-line", aliases: ["tps"] },
              run: () => {
                const sessionID = currentSession()
                context.ui.dialog.set({ size: "large" })
                context.ui.dialog.show(() => <Stats sessionID={sessionID} />)
              },
            },
            {
              id: "opencode-status-line.summary",
              title: "Session: summarize current session",
              group: "opencode-status-line",
              palette: true,
              slash: { name: "summary" },
              run: () => {
                const sessionID = currentSession()
                if (sessionID) void generateSummary(sessionID)
                else context.ui.toast.show({ variant: "warning", message: "Open a session before creating a summary." })
              },
            },
            {
              id: "opencode-status-line.instructions",
              title: "Session: choose always-active instructions",
              group: "opencode-status-line",
              palette: true,
              slash: { name: "instructions" },
              run: () => openInstructionPicker("always"),
            },
            {
              id: "opencode-status-line.instruction.once",
              title: "Session: trigger instruction for next prompt",
              group: "opencode-status-line",
              palette: true,
              slash: { name: "instruction" },
              run: () => openInstructionPicker("slash"),
            },
            {
              id: "opencode-status-line.instruction.add",
              title: "Instructions: add to library",
              group: "opencode-status-line",
              palette: true,
              slash: { name: "instruction-add" },
              run: () => void addInstruction(),
            },
            {
              id: "opencode-status-line.instruction.toggle",
              title: "Instructions: enable or disable",
              group: "opencode-status-line",
              palette: true,
              slash: { name: "instruction-toggle" },
              run: () => void toggleInstruction(),
            },
            {
              id: "opencode-status-line.instruction.delete",
              title: "Instructions: delete from library",
              group: "opencode-status-line",
              palette: true,
              slash: { name: "instruction-delete" },
              run: () => void deleteInstruction(),
            },
            {
              id: "opencode-status-line.project-terminal",
              title: "Project: open PowerShell",
              group: "opencode-status-line",
              palette: true,
              slash: { name: "terminal" },
              run: () => openProjectPowerShell(),
            },
            {
              id: "opencode-status-line.summaries",
              title: "Session: browse saved summaries",
              group: "opencode-status-line",
              palette: true,
              slash: { name: "summaries" },
              run: async () => {
                const entries = Object.values(summaryState.entries)
                const active = currentSession()
                const activeProject = active ? context.data.session.get(active)?.projectID : undefined
                const projectEntries = entries.filter((entry) => entry.projectID === activeProject)
                if (!entries.length) {
                  context.ui.toast.show({ variant: "info", message: "No saved summaries yet. Use /summary first." })
                  return
                }
                const scope = projectEntries.length
                  ? await context.ui.dialog.select({
                      title: "Choose summary scope",
                      options: [
                        { title: "Current project", description: `${projectEntries.length} summaries`, value: "project" },
                        { title: "All projects", description: `${entries.length} summaries`, value: "all" },
                      ],
                    current: "project",
                    })
                  : "all"
                if (!scope) return
                if (!active) {
                  context.ui.toast.show({ variant: "warning", message: "Open a session before attaching summaries." })
                  return
                }
                const activeInfo = context.data.session.get(active)
                const metadata = activeInfo?.metadata as Record<string, unknown> | undefined
                const rawAttachments = metadata?.[SUMMARY_ATTACHMENT_METADATA_KEY]
                const priorAttachments = Array.isArray(rawAttachments)
                  ? rawAttachments.filter((value): value is SummaryAttachment => {
                      if (!value || typeof value !== "object") return false
                      const item = value as Record<string, unknown>
                      return (
                        typeof item.sessionID === "string" &&
                        typeof item.projectID === "string" &&
                        typeof item.title === "string" &&
                        typeof item.summary === "string" &&
                        typeof item.updatedAt === "number"
                      )
                    })
                  : []
                const priorSummaries: SessionSummary[] = priorAttachments.map((entry) =>
                  summaryState.entries[entry.sessionID] ?? { ...entry, sourceUpdatedAt: entry.updatedAt },
                )
                const candidateIDs = new Set((scope === "project" ? projectEntries : entries).map((entry) => entry.sessionID))
                const candidates = [...(scope === "project" ? projectEntries : entries), ...priorSummaries.filter((entry) => !candidateIDs.has(entry.sessionID))]
                  .slice()
                  .sort((left, right) => right.updatedAt - left.updatedAt)
                setSelectedSummaryIDs(priorAttachments.map((entry) => entry.sessionID))
                setSummaryPickerCursor(0)
                setSummaryPicker({ sessionID: active, entries: candidates })
                context.ui.dialog.set({ size: "xlarge" })
                context.ui.dialog.show(() => <SummaryPicker />)
              },
            },
          ],
        }))
        context.keymap.layer(() => ({
          mode: "modal",
          enabled: () => Boolean(summaryPicker() || instructionPicker()),
          priority: 100,
          commands: [
            {
              id: "opencode-status-line.summaries.up",
              title: "Picker: previous item",
              bind: "up",
              run: () => {
                try {
                  setSummaryPickerCursor((index) => Math.max(0, index - 1))
                  if (summaryPicker()) summaryDetailScroll?.scrollTo(0)
                } catch (error) {
                  console.warn("opencode-status-line: summary picker navigation failed", error)
                }
              },
            },
            {
              id: "opencode-status-line.summaries.down",
              title: "Picker: next item",
              bind: "down",
              run: () => {
                try {
                  const count = summaryPicker()?.entries.length ?? instructionPicker()?.entries.length ?? 1
                  setSummaryPickerCursor((index) => Math.min(count - 1, index + 1))
                  if (summaryPicker()) summaryDetailScroll?.scrollTo(0)
                } catch (error) {
                  console.warn("opencode-status-line: summary picker navigation failed", error)
                }
              },
            },
            {
              id: "opencode-status-line.summaries.toggle",
              title: "Picker: toggle selection",
              bind: "space",
              run: () => {
                try {
                  if (summaryPicker()) {
                    const entry = summaryPicker()?.entries[summaryPickerCursor()]
                    if (!entry) return
                    setSelectedSummaryIDs((selected) =>
                      selected.includes(entry.sessionID)
                        ? selected.filter((id) => id !== entry.sessionID)
                        : [...selected, entry.sessionID],
                    )
                  } else {
                    const entry = instructionPicker()?.entries[summaryPickerCursor()]
                    if (!entry) return
                    setSelectedInstructionIDs((selected) =>
                      selected.includes(entry.id) ? selected.filter((id) => id !== entry.id) : [...selected, entry.id],
                    )
                  }
                } catch (error) {
                  console.warn("opencode-status-line: summary selection failed", error)
                }
              },
            },
            {
              id: "opencode-status-line.summaries.detail.pageup",
              title: "Summary details: scroll up",
              bind: "pageup",
              enabled: () => Boolean(summaryPicker()),
              run: () => summaryDetailScroll?.scrollBy(-12),
            },
            {
              id: "opencode-status-line.summaries.detail.pagedown",
              title: "Summary details: scroll down",
              bind: "pagedown",
              enabled: () => Boolean(summaryPicker()),
              run: () => summaryDetailScroll?.scrollBy(12),
            },
            {
              id: "opencode-status-line.summaries.attach",
              title: "Picker: apply selection",
              bind: "enter",
              run: () => {
                const attach = instructionPicker() ? attachInstructionSelection : attachSummarySelection
                void attach().catch((error) => {
                  context.ui.toast.show({
                    variant: "error",
                    title: "Could not apply selection",
                    message: error instanceof Error ? error.message : String(error),
                  })
                })
              },
            },
            {
              id: "opencode-status-line.summaries.cancel",
              title: "Picker: close",
              bind: "escape",
              run: () => {
                try {
                  setSummaryPicker(undefined)
                  setInstructionPicker(undefined)
                  context.ui.dialog.clear()
                } catch (error) {
                  console.warn("opencode-status-line: could not close summary picker", error)
                }
              },
            },
          ],
        }))
        return null
      },
    })

    const sidebarSession = () => {
      const sessionID = currentSession()
      const session = sessionID ? context.data.session.get(sessionID) : undefined
      return { sessionID, metadata: (session?.metadata ?? {}) as Record<string, unknown> }
    }
    const refreshToolInventory = async () => {
      if (toolInventoryLoading()) return
      setToolInventoryLoading(true)
      setToolInventoryError(false)
      try {
        const directory = sidebarSession().sessionID
          ? context.data.session.get(sidebarSession().sessionID!)?.location.directory
          : context.location?.directory ?? context.data.location.default()?.directory
        const result = await context.client.rpc.call({
          rpcID: TOOL_INVENTORY_RPC.id,
          method: "list",
          input: {},
          location: directory ? { directory } : undefined,
        })
        const raw = (result as { data?: { output?: unknown }; output?: unknown }).data?.output ?? (result as { output?: unknown }).output
        if (!raw || typeof raw !== "object") throw new Error("Tool inventory response was empty")
        const value = raw as Partial<ToolInventory>
        if (!Array.isArray(value.tools) || typeof value.estimatedTokens !== "number") throw new Error("Tool inventory response was invalid")
        setToolInventory(value as ToolInventory)
      } catch (error) {
        setToolInventoryError(true)
        console.warn("opencode-status-line: could not load tool inventory", error)
      } finally {
        setToolInventoryLoading(false)
      }
    }
    const showToolInventory = async () => {
      await refreshToolInventory()
      const inventory = toolInventory()
      if (!inventory) {
        context.ui.toast.show({ variant: "warning", message: "Tool inventory is unavailable. Check that the companion server plugin is loaded." })
        return
      }
      const model = context.ui.model.current()
      const limit = contextLimit(model ? { id: model.modelID, providerID: model.providerID } : undefined)
      const percentage = limit ? ` (~${(inventory.estimatedTokens / limit * 100).toFixed(1)}% of selected model context)` : " (model context limit unavailable)"
      context.ui.dialog.set({ size: "large" })
      context.ui.dialog.show(() => (
        <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
          <text>{`Registered tools: ${inventory.tools.length} | ~${inventory.estimatedTokens.toLocaleString()} tokens${percentage}`}</text>
          <text>Combined inventory from built-in, plugin, and MCP tools. Token count is a character-based estimate, not exact prompt usage or MCP-only usage.</text>
          <For each={inventory.tools.slice(0, 80)}>
            {(tool) => <text wrapMode="word">{`${tool.id} (~${tool.estimatedTokens} tokens)${tool.description ? ` — ${tool.description}` : ""}`}</text>}
          </For>
          <Show when={inventory.tools.length > 80}><text>{`Showing 80 of ${inventory.tools.length} tools.`}</text></Show>
        </box>
      ))
    }
    void refreshToolInventory()
    const toggleSidebarSummary = async (entry: SessionSummary) => {
      const { sessionID, metadata } = sidebarSession()
      if (!sessionID) {
        context.ui.toast.show({ variant: "warning", message: "Open a session before attaching a summary." })
        return
      }
      const activeInfo = context.data.session.get(sessionID)
      if (!activeInfo) return
      const raw = metadata[SUMMARY_ATTACHMENT_METADATA_KEY]
      const attached = Array.isArray(raw) ? raw.filter((value): value is SummaryAttachment => {
        if (!value || typeof value !== "object") return false
        const item = value as Record<string, unknown>
        return typeof item.sessionID === "string" && typeof item.projectID === "string" && typeof item.title === "string" && typeof item.summary === "string" && typeof item.updatedAt === "number"
      }) : []
      const exists = attached.some((item) => item.sessionID === entry.sessionID)
      const next = exists
        ? attached.filter((item) => item.sessionID !== entry.sessionID)
        : [...attached, { sessionID: entry.sessionID, projectID: entry.projectID, title: entry.title, summary: entry.summary, updatedAt: entry.updatedAt }]
      await context.client.session.update({ sessionID, metadata: { ...activeInfo.metadata, [SUMMARY_ATTACHMENT_METADATA_KEY]: next } })
      context.ui.toast.show({ variant: "info", message: exists ? `Detached summary: ${entry.title}` : `Attached summary: ${entry.title}` })
    }
    const toggleSidebarInstruction = async (entry: UserInstruction) => {
      const { sessionID, metadata } = sidebarSession()
      if (!sessionID) {
        context.ui.toast.show({ variant: "warning", message: "Open a session before selecting instructions." })
        return
      }
      const activeInfo = context.data.session.get(sessionID)
      if (!activeInfo) return
      const key = entry.mode === "always" ? SESSION_INSTRUCTIONS_METADATA_KEY : PENDING_INSTRUCTIONS_METADATA_KEY
      const selected = validInstructionSnapshots(metadata[key])
      const exists = selected.some((item) => item.id === entry.id)
      const next = exists ? selected.filter((item) => item.id !== entry.id) : [...selected, { id: entry.id, title: entry.title, prompt: entry.prompt, mode: entry.mode }]
      await context.client.session.update({ sessionID, metadata: { ...activeInfo.metadata, [key]: next } })
      context.ui.toast.show({ variant: "info", message: exists ? `Removed instruction: ${entry.title}` : `Selected instruction: ${entry.title}` })
    }

    context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const session = sidebarSession()
        const rawAttachments = session.metadata[SUMMARY_ATTACHMENT_METADATA_KEY]
        const attachments: SummaryAttachment[] = Array.isArray(rawAttachments)
          ? rawAttachments.filter((value): value is SummaryAttachment => {
              if (!value || typeof value !== "object") return false
              const item = value as Record<string, unknown>
              return typeof item.sessionID === "string" && typeof item.projectID === "string" && typeof item.title === "string" && typeof item.summary === "string" && typeof item.updatedAt === "number"
            })
          : []
        const sessionInstructions = validInstructionSnapshots(session.metadata[SESSION_INSTRUCTIONS_METADATA_KEY])
        const pendingInstructions = validInstructionSnapshots(session.metadata[PENDING_INSTRUCTIONS_METADATA_KEY])
        const enabledItems = instructionLibrary.items.filter((item) => item.enabled)
        const visibleInstructions = [...instructionLibrary.items.filter((item) =>
          item.enabled || sessionInstructions.some((selected) => selected.id === item.id) || pendingInstructions.some((selected) => selected.id === item.id),
        )]
        const projectID = session.sessionID ? context.data.session.get(session.sessionID)?.projectID : undefined
        const visibleSummaries = Object.values(summaryState.entries)
          .filter((entry) => !projectID || entry.projectID === projectID)
          .sort((left, right) => right.updatedAt - left.updatedAt)
        const selectedModel = context.ui.model.current()
        const modelLimit = contextLimit(selectedModel ? { id: selectedModel.modelID, providerID: selectedModel.providerID } : undefined)
        const toolPercent = toolInventory() && modelLimit
          ? ` (~${(toolInventory()!.estimatedTokens / modelLimit * 100).toFixed(1)}%)`
          : ""
        return (
          <box flexDirection="column" gap={1}>
            <text wrapMode="none" onMouseUp={safely(() => void showToolInventory())}>
              Tools ({toolInventoryLoading() ? "…" : toolInventory()?.tools.length ?? "?"}){toolInventory() ? ` | ~${toolInventory()!.estimatedTokens.toLocaleString()} tokens${toolPercent}` : toolInventoryError() ? " | unavailable" : " | inspect"}
            </text>
            <box flexDirection="column">
              <text wrapMode="none" onMouseUp={() => setSummarySectionOpen((open) => !open)}>
                {summarySectionOpen() ? "[-]" : "[+]"} Summaries ({visibleSummaries.length}){summaryStatusText() ? ` | ${summaryStatusText()}` : ""}
              </text>
              <Show when={summarySectionOpen()}>
                <Show when={visibleSummaries.length > 0} fallback={<text>No saved summaries yet. Use /summary.</text>}>
                  <For each={visibleSummaries}>
                    {(entry) => (
                      <text wrapMode="none" onMouseUp={safely(() => void toggleSidebarSummary(entry))}>
                        {attachments.some((item) => item.sessionID === entry.sessionID) ? "  [x] " : "  [ ] "}{entry.title}
                      </text>
                    )}
                  </For>
                </Show>
                <text wrapMode="none" onMouseUp={safely(() => {
                  const sessionID = currentSession()
                  if (sessionID) void generateSummary(sessionID)
                })}>+ Summarize this session</text>
              </Show>
            </box>
            <box flexDirection="column">
              <text wrapMode="none" onMouseUp={() => setInstructionSectionOpen((open) => !open)}>
                {instructionSectionOpen() ? "[-]" : "[+]"} Instructions ({enabledItems.length} enabled)
              </text>
              <Show when={instructionSectionOpen()}>
                <Show when={visibleInstructions.length > 0} fallback={<text wrapMode="none">No saved instructions</text>}>
                  <For each={visibleInstructions}>
                    {(entry) => {
                      const selected = () => (entry.mode === "always" ? sessionInstructions : pendingInstructions).some((item) => item.id === entry.id)
                      return (
                        <text wrapMode="none" onMouseUp={safely(() => void toggleSidebarInstruction(entry))}>
                          {selected() ? "  [x] " : "  [ ] "}{entry.mode === "always" ? "Always" : "Once"} - {entry.title}
                        </text>
                      )
                    }}
                  </For>
                </Show>
                <text wrapMode="none" onMouseUp={safely(() => openInstructionPicker("always"))}>Choose session</text>
                <text wrapMode="none" onMouseUp={safely(() => openInstructionPicker("slash"))}>Queue next prompt</text>
              </Show>
            </box>
          </box>
        )
      },
    })
    context.ui.slot({
      append: "sidebar.footer",
      render: () => <text wrapMode="none" onMouseUp={safely(() => openProjectPowerShell())}>PowerShell</text>,
    })

    /** One drawn row: the plain runs, a run that takes clicks, then the rest. */
    interface RowView {
      before: Run[]
      clickable?: Run
      after: Run[]
    }

    /**
     * A renderer for one placement. Each configured surface gets its own
     * instance: it closes over that surface's layout facts (stack direction,
     * padding, row sharing) and its measured width is its own — two
     * placements are two boxes, each dealt its own width by the host — while
     * all of them repaint from the one shared `version` signal.
     */
    const renderFor = (surface: Surface) => (input: { sessionID?: string }) => {
      const stack = stackFor(surface)
      const padding = resolvedPadding(config, surface)
      const sharesRow = sharesHostRow(surface)
      // The placement's own segment list, or the shared `usage.segments`.
      const segments = segmentsFor(config, surface)
      /**
       * The width the host actually dealt this box, reported by layout. A
       * footer row shares its width with the host's own content, so the
       * renderer's width cannot say how much is ours; only the box can.
       */
      const [fitted, setFitted] = createSignal<number | undefined>(undefined)
      /**
       * The guards that own this placement's tree. `valueGuard` covers the row
       * build — its fallback is the figures already on screen — while
       * `rowGuard` and `boxGuard` cover the renderables themselves, where a
       * throw leaves nothing to draw at all and every further attempt would
       * abandon another set of the host's native objects. Only those two latch.
       * See guard.ts for the policy and the reason it exists.
       */
      const valueGuard = createGuard({ label: "the figures" })
      const rowGuard = createGuard({ label: "a row", advice: "restart OpenCode" })
      const boxGuard = createGuard({ label: "the line box", advice: "restart OpenCode" })
      /** An empty line: no session, nothing to draw, or a latch. */
      const emptyView = (): { lines: RowView[]; basis: number } => ({ lines: [], basis: 0 })
      /**
       * The last rows this placement actually drew, and for which session. A
       * build that throws holds them rather than blanking the line, dimmed so
       * the freeze is visible; they are dropped the moment the session changes,
       * because figures from another conversation are worse than none.
       */
      let held: { sessionID: string; lines: RowView[]; basis: number } | undefined
      /** Latched shut: nothing can be drawn, so nothing is built or retried. */
      const dead = () => rowGuard.broken || boxGuard.broken
      /** The held rows, dimmed; empty when this session has none. */
      const heldView = (sessionID: string): { lines: RowView[]; basis: number } => {
        if (!held || held.sessionID !== sessionID) return emptyView()
        return {
          basis: held.basis,
          lines: held.lines.map((row) => ({
            before: dimRuns(row.before),
            clickable: row.clickable ? dimRuns([row.clickable])[0] : undefined,
            after: dimRuns(row.after),
          })),
        }
      }
      /**
       * Everything drawn is rebuilt through this build, inside the memo below.
       * The parts must not be a plain array computed in the component body:
       * `Show` calls its children untracked, so a static build is evaluated
       * once and then frozen — the symptom being a line that never repaints. A
       * memo re-reads `version()` (deltas and the ticker) and every repaint gets
       * fresh readings.
       *
       * A sidebar surface stacks the segments, one per row, each cut to the
       * column's width. A row surface joins the segments across one line and
       * moves whole segments that do not fit to a further row — as many as the
       * width demands. It fits to the box's own measured width, which is read
       * after every layout and therefore also follows a resize without waiting
       * for the heartbeat.
       *
       * A run with `onClick` is hoisted out of the plain text into its own
       * `<text>`: mouse handlers live on renderables, and a `span` is not one.
       */
      const buildView = (sessionID: string): { lines: RowView[]; basis: number } => {
        const rows = usageRows(segments, sessionID, Date.now())
        if (rows.length === 0) return emptyView()
        const viewport = (context as { renderer?: { width?: number } }).renderer?.width
        const window = typeof viewport === "number" && viewport > 0 ? viewport : undefined
        const lines: Run[][] = []
        if (stack === "column") {
          for (const runs of rows) {
            // A sidebar column is cut to its width with the padding kept in
            // reserve, so configured padding cannot push it past the edge.
            const room =
              window !== undefined
                ? Math.max(1, columnWidth(window) - padding.left - padding.right)
                : undefined
            lines.push(room !== undefined ? cutRuns(runs, room) : runs)
          }
        } else {
          // A row fits itself to the width its box was actually dealt.
          // `renderer.width` is the window and would overstate a footer row
          // shared with the host's own content, so prefer the box's own
          // laid-out width, measured after the first paint; the renderer
          // covers the paint before that measurement exists.
          const measured = fitted()
          const granted = measured !== undefined && measured > 0 ? measured : window
          const room =
            granted !== undefined ? Math.max(1, granted - padding.left - padding.right) : undefined
          if (room !== undefined) lines.push(...wrapRows(rows, room, config.usageSeparator))
          else lines.push(joinRows(rows))
        }
        const drawn = {
          basis: joinedWidth(rows, config.usageSeparator),
          lines: lines
            .filter((runs) => runs.length > 0)
            .map((runs) => {
              const at = runs.findIndex((run) => run.onClick)
              if (at < 0) return { before: runs, after: [] }
              return { before: runs.slice(0, at), clickable: runs[at], after: runs.slice(at + 1) }
            }),
        }
        held = { sessionID, lines: drawn.lines, basis: drawn.basis }
        return drawn
      }
      const view = createMemo<{ lines: RowView[]; basis: number }>(() => {
        if (dead()) return emptyView()
        // The heartbeat's clock: held figures and the elapsed timer repaint
        // even while nothing is streaming.
        version()
        // Slots such as `prompt.footer` carry no session in their input; the
        // route knows which conversation is on screen. Without one — the home
        // screen, a plugin page — the line stays hidden rather than describing
        // a conversation that is not open.
        const sessionID = input?.sessionID ?? currentSession()
        if (!sessionID) {
          held = undefined
          return emptyView()
        }
        // A build that throws holds the last figures instead of blanking the
        // line; the next paint tries again.
        return valueGuard.attempt(() => buildView(sessionID), () => heldView(sessionID))
      })
      /** The runs as one piece of text: what a row still says without colour. */
      const rowText = (runs: Run[]): string => runs.map((run) => run.text).join("")
      // A `span` takes its colour through `style`, not a bare `fg` prop:
      // @opentui/solid drops `fg` on spans, which paints the whole line in
      // the default foreground. Text renderables below still take `fg`.
      //
      // Spans are also the first thing to give way: building one runs the
      // colourizer, and a line without colour is still a line.
      const spans = (runs: Run[]): JSX.Element =>
        inkGuard.attempt<JSX.Element>(
          () =>
            runs.map((run) => (
              <span style={{ fg: toneColor(run.tone, run.dim ?? false, run.host ?? false) }}>{run.text}</span>
            )),
          () => rowText(runs),
        )
      const [hovered, setHovered] = createSignal(false)
      const textLine = (runs: Run[]) => <text wrapMode="none">{spans(runs)}</text>
      /** The clickable run: a mouse handler needs a renderable of its own. */
      const clickLine = (run: Run) => (
        <text
          wrapMode="none"
          onMouseOver={() => setHovered(true)}
          onMouseOut={() => setHovered(false)}
          onMouseUp={() => run.onClick?.()}
          fg={
            hovered()
              ? toneColor(undefined, false, run.host ?? false)
              : toneColor(run.tone, run.dim ?? false, run.host ?? false)
          }
        >
          {spans([run])}
        </text>
      )
      /**
       * One row drawn the good way. Its parts are built here rather than left
       * to the host's lazy children getters, so that a renderable which cannot
       * be created at all throws inside `rowTree`'s guard instead of somewhere
       * this plugin never sees.
       *
       * A row is always its own flex row, so a clickable run sharing it stays
       * on the same line when the outer box is a column.
       */
      const richRow = (row: RowView) => {
        const parts: JSX.Element[] = []
        if (row.before.length > 0) parts.push(textLine(row.before))
        if (row.clickable) parts.push(clickLine(row.clickable))
        if (row.after.length > 0) parts.push(textLine(row.after))
        return <box flexDirection="row">{parts}</box>
      }
      /**
       * The same row in one piece of plain text — no spans, no colour, no click.
       * The text is what the line is for; the rest is decoration, and a row that
       * cannot be decorated is still worth drawing.
       */
      const plainRow = (row: RowView) => (
        <box flexDirection="row">
          <text wrapMode="none">
            {rowText(row.before) + (row.clickable ? rowText([row.clickable]) : "") + rowText(row.after)}
          </text>
        </box>
      )
      /** A row: the good drawing, else the plain one, else nothing at all. */
      const rowTree = (row: RowView) =>
        rowGuard.attempt(
          () => richRow(row),
          () => rowGuard.lastResort(() => plainRow(row)),
        )
      if (dead()) return null
      /**
       * The box around the rows is the last thing that can fail. When even it
       * cannot be built there is nothing to draw with, and the guard latches so
       * that the retry loop stops: every further attempt would abandon a little
       * more of the host's native handle pool (see guard.ts). `Line` is a
       * component so that the box — not just the `Show` above it — is built
       * inside the guard.
       */
      const Line = () =>
        boxGuard.lastResort(() => (
          <box
            flexDirection="column"
            minWidth={0}
            // A row child's width is dealt by the host's row, and its wrapped
            // content must not become the basis of that deal: hold the
            // unwrapped width, or a narrow layout would pin the box narrow
            // for good. `app` and the composer top stretch to the window and
            // need no basis.
            flexBasis={sharesRow ? view().basis : undefined}
            // The box must never be shrunk below its drawn height. The host
            // puts it in a column that can overflow — a transcript taller than
            // the window, most of the time — and Yoga's shrink then squashes a
            // wrapped box into itself, drawing every row on the same line.
            // `minHeight` is the content plus the padding, which is part of
            // the border box.
            minHeight={view().lines.length + padding.top + padding.bottom}
            paddingLeft={padding.left}
            paddingRight={padding.right}
            paddingTop={padding.top}
            paddingBottom={padding.bottom}
            onSizeChange={function (this: { width: number }) {
              const width = this.width
              // Deferred: the handler runs inside layout, and writing the
              // signal directly would re-enter the render that caused it.
              queueMicrotask(() => setFitted(width))
            }}
          >
            <For each={view().lines}>{(row) => rowTree(row)}</For>
          </box>
        ))
      return (
        <Show when={view().lines.length > 0}>
          <Line />
        </Show>
      )
    }

    // The placement key is the verb (`append`); its value is the slot path.
    // One registration per configured placement: `config.surface` is a list,
    // and each surface gets its own renderer because the layout facts differ
    // (a sidebar stacks, a footer shares its row, `app` carries its indent) —
    // all of them repainting from the one shared `version` signal.
    for (const surface of config.surface) {
      context.ui.slot({ append: surface, render: renderFor(surface) })
    }

    return () => {
      for (const stop of stops) stop()
      if (timer) clearInterval(timer)
      clearInterval(heartbeat)
      for (const idleTimer of idleTimers.values()) clearTimeout(idleTimer)
      idleTimers.clear()
      mcpRecoveryDisposed = true
      for (const retry of mcpRetries.values()) if (retry.timer) clearTimeout(retry.timer)
      mcpRetries.clear()
    }
  },
})
