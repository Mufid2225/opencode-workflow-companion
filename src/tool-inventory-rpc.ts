import { Rpc } from "@opencode/schema/rpc"

const stringSchema = { type: "string" } as const

export const TOOL_INVENTORY_RPC = Rpc.define({
  id: "opencode-status-line-tool-inventory",
  methods: {
    list: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          tools: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: stringSchema,
                description: stringSchema,
                schema: stringSchema,
                estimatedTokens: { type: "integer", minimum: 0 },
              },
              required: ["id", "description", "schema", "estimatedTokens"],
              additionalProperties: false,
            },
          },
          estimatedTokens: { type: "integer", minimum: 0 },
        },
        required: ["tools", "estimatedTokens"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})
