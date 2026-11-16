import { z } from "zod"

/** One broadcast API token per submit; the Add button can be used again for more pages. */
export const connectAhachatSchema = z.object({
  token: z.string().trim().min(1),
})
export type ConnectAhachatSchema = z.infer<typeof connectAhachatSchema>
