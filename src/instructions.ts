export type UserInstruction = {
  id: string
  title: string
  prompt: string
  mode: "always" | "slash"
  enabled: boolean
  createdAt: number
}

export type InstructionSnapshot = Pick<UserInstruction, "id" | "title" | "prompt" | "mode">

export const SESSION_INSTRUCTIONS_METADATA_KEY = "opencodeStatusLineSessionInstructions"
export const PENDING_INSTRUCTIONS_METADATA_KEY = "opencodeStatusLinePendingInstructions"
