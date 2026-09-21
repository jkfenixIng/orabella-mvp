import { z } from "zod";
import { ok } from "@/src/shared/lib/api-response";

const healthDataSchema = z.object({
  status: z.literal("ok"),
});

const healthResponseSchema = z.object({
  success: z.literal(true),
  data: healthDataSchema,
});

export async function GET() {
  const payload = healthResponseSchema.parse({
    success: true as const,
    data: { status: "ok" as const },
  });
  return ok(payload.data);
}
