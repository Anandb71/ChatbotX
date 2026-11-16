import { z } from "zod"

/** Channel of an AhaChat page, as the AhaChat contact API names it. */
export const ahachatChannels = z.enum([
  "messenger",
  "instagram",
  "zalo",
  "google_business_message",
  "whatsapp",
  "telegram",
])
export type AhachatChannel = z.infer<typeof ahachatChannels>
