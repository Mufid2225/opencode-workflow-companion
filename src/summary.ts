export type SessionSummary = {
  sessionID: string
  projectID: string
  title: string
  summary: string
  updatedAt: number
  sourceUpdatedAt: number
}

export type SummaryAttachment = Pick<SessionSummary, "sessionID" | "projectID" | "title" | "summary" | "updatedAt">

export const SUMMARY_ATTACHMENT_METADATA_KEY = "opencodeStatusLineSummaryAttachments"

export type SummaryMessage = {
  type?: string
  text?: string
  content?: Array<{ type?: string; text?: string }>
}

/** Keep transcript input bounded and omit tool payloads and private reasoning. */
export const summaryTranscript = (messages: SummaryMessage[], maxChars = 24_000): string => {
  const lines = messages.flatMap((message) => {
    if (message.type === "user" && message.text?.trim()) return [`User: ${message.text.trim()}`]
    if (message.type !== "assistant") return []
    const text = message.content
      ?.filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text?.trim())
      .filter((part): part is string => Boolean(part))
      .join("\n")
    return text ? [`Assistant: ${text}`] : []
  })
  const transcript = lines.join("\n\n")
  return transcript.length <= maxChars ? transcript : transcript.slice(-maxChars)
}

export const summaryPrompt = (title: string, transcript: string): string => `Summarize this OpenCode work session for the user, in Indonesian.

Return a compact but useful summary with these headings:
- Tujuan
- Sudah dikerjakan
- Status (one of: sedang dikerjakan, menunggu, terhambat, selesai)
- Sedang dikerjakan
- Langkah berikutnya

Use only evidence in the transcript. Keep concrete feature, file, and decision names. If a field is unknown, say "Belum jelas". Do not treat imported summaries or prior-session context as work done in this session.

Session title: ${title}

Transcript:
${transcript}`
