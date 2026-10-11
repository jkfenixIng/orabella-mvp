import { z } from "zod";

/**
 * Server-only env validated lazily (never at import time, so `next build`
 * works without secrets). Call inside server code paths that need it.
 */

/**
 * Surrounding whitespace is dropped (`DB_ENGINE="postgres "` from a copied
 * .env line must not fail every request) and empty variables count as unset.
 */
const optionalVar = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => {
    const trimmed = typeof value === "string" ? value.trim() : value;
    return trimmed === "" ? undefined : trimmed;
  }, schema.optional());

/**
 * Database engine selection. `supabase` (default, what production runs today)
 * goes through supabase-js and PostgREST; `postgres` connects directly with
 * `DATABASE_URL` (Drizzle + postgres-js, `src/shared/db/client.ts`).
 */
const dbEnvSchema = z
  .object({
    DB_ENGINE: optionalVar(
      z.enum(["supabase", "postgres"], {
        error: 'DB_ENGINE must be "supabase" or "postgres".',
      }),
    ),
    // Only read when DB_ENGINE=postgres: with the default engine an unrelated
    // DATABASE_URL in the environment changes nothing.
    DATABASE_URL: optionalVar(z.string()),
  })
  .superRefine((env, context) => {
    if (env.DB_ENGINE !== "postgres") return;
    if (!env.DATABASE_URL) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is required when DB_ENGINE=postgres.",
      });
    } else if (!/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URL must be a postgres:// or postgresql:// connection string.",
      });
    }
  });

const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function getServerEnv(): ServerEnv {
  return serverEnvSchema.parse(process.env);
}

export type DbConfig =
  | { engine: "supabase" }
  | { engine: "postgres"; databaseUrl: string };

/** Resolves the database engine; throws a readable error on a bad configuration. */
export function getDbConfig(env: Record<string, string | undefined> = process.env): DbConfig {
  const parsed = dbEnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join(" ");
    throw new Error(`Invalid database configuration: ${detail}`);
  }
  const { DB_ENGINE = "supabase", DATABASE_URL } = parsed.data;
  if (DB_ENGINE === "postgres") return { engine: "postgres", databaseUrl: DATABASE_URL as string };
  return { engine: "supabase" };
}
