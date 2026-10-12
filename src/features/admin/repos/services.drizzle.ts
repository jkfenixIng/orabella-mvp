/**
 * Direct PostgreSQL adapter of the service catalog port (`./services.ts`).
 * Runs the same reads and writes as the supabase-js adapter over Drizzle.
 *
 * SERVER ONLY and loaded on demand: `servicesRepo()` imports this module with
 * `import()` only when DB_ENGINE=postgres. The database instance is injected,
 * so the tests run it against PGlite.
 */
import { and, asc, count, eq, ilike, or, sql } from "drizzle-orm";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";
import { services } from "@/src/shared/db/schema/services";
import type { Database } from "@/src/shared/db/client";
import { containsPattern, type ServiceRow, type ServicesRepo, type ServiceWrite } from "./services";

/** Same columns, same names and same JS types as SERVICE_SELECT over PostgREST. */
const SERVICE_COLUMNS = {
  id: services.id,
  name: services.name,
  description: services.description,
  price: services.price,
  duracion_min: services.duracionMin,
  duracion_max: services.duracionMax,
  is_active: services.isActive,
};

/**
 * `numeric(12,2)` reaches JS as a number (PostgREST sends it as a JSON number).
 * Drizzle's `number` mode already converts the driver's text; this guards the
 * invariant so money never leaves the repository as a string.
 */
function toServiceRow(row: Record<keyof ServiceRow, unknown>): ServiceRow {
  const price = typeof row.price === "number" ? row.price : Number(row.price);
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description ?? null) as string | null,
    price,
    duracion_min: row.duracion_min as number,
    duracion_max: row.duracion_max as number,
    is_active: row.is_active as boolean,
  };
}

/** The PostgREST upsert only writes the keys the payload carries. */
const EXCLUDED: Record<keyof Omit<ServiceWrite, "id">, ReturnType<typeof sql.raw>> = {
  name: sql.raw("excluded.name"),
  description: sql.raw("excluded.description"),
  price: sql.raw("excluded.price"),
  duracion_min: sql.raw("excluded.duracion_min"),
  duracion_max: sql.raw("excluded.duracion_max"),
  is_active: sql.raw("excluded.is_active"),
};

export function drizzleServicesRepo(db: Database): ServicesRepo {
  return {
    async listPage({ query, active, limit, offset }) {
      const needle = query.trim();
      const pattern = containsPattern(needle);
      const where = and(
        needle === "" ? undefined : or(ilike(services.name, pattern), ilike(services.description, pattern)),
        active === undefined ? undefined : eq(services.isActive, active),
      );
      try {
        const [rows, [{ total }]] = await Promise.all([
          db
            .select(SERVICE_COLUMNS)
            .from(services)
            .where(where)
            .orderBy(asc(services.name), asc(services.id))
            .limit(limit)
            .offset(offset),
          db.select({ total: count() }).from(services).where(where),
        ]);
        return { rows: rows.map(toServiceRow), total: Number(total) };
      } catch (error) {
        throw new DbQueryError(toDbError(error));
      }
    },
    async list(limit) {
      try {
        const rows = await db
          .select(SERVICE_COLUMNS)
          .from(services)
          .orderBy(asc(services.name))
          .limit(limit);
        return rows.map(toServiceRow);
      } catch (error) {
        throw new DbQueryError(toDbError(error));
      }
    },
    async upsert(write) {
      const values = {
        ...(write.id ? { id: write.id } : {}),
        name: write.name,
        description: write.description,
        price: write.price,
        duracionMin: write.duracion_min,
        duracionMax: write.duracion_max,
        ...(write.is_active !== undefined ? { isActive: write.is_active } : {}),
      };
      const set = {
        name: EXCLUDED.name,
        description: EXCLUDED.description,
        price: EXCLUDED.price,
        duracionMin: EXCLUDED.duracion_min,
        duracionMax: EXCLUDED.duracion_max,
        ...(write.is_active !== undefined ? { isActive: EXCLUDED.is_active } : {}),
      };
      try {
        const rows = await db
          .insert(services)
          .values(values)
          .onConflictDoUpdate({ target: services.id, set })
          .returning(SERVICE_COLUMNS);
        return rows[0] ? toServiceRow(rows[0]) : null;
      } catch (error) {
        throw new DbQueryError(toDbError(error));
      }
    },
  };
}
