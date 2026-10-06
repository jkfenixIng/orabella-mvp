import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------------
   Guardas de contrato del ORDEN de las redes de conteo (fix-060, sin red/DB).

   En PL/pgSQL, `GET DIAGNOSTICS x = ROW_COUNT` devuelve el conteo de filas de la
   ÚLTIMA sentencia ejecutada. Un `SELECT ... INTO` también es una sentencia, y
   deja `ROW_COUNT` en 1. Por eso una guarda escrita así:

       INSERT ...;
       SELECT jsonb_array_length(p_items) INTO v_esperados;  -- pisa ROW_COUNT
       GET DIAGNOSTICS v_escritos = ROW_COUNT;               -- mide el SELECT

   no mide el `INSERT` sino el `SELECT`: `v_escritos` queda en 1 y la emisión
   falla con ITEM_MISMATCH en cuanto un grupo trae 2+ elementos. Ese es,
   exactamente, el defecto de `052_invoice_create_atomic.sql` que la migración
   `060_fix_invoice_create_guards.sql` corrige. El orden correcto es:

       SELECT jsonb_array_length(...) INTO v_esperados;  -- COUNT, antes
       INSERT ...;                                       -- la ESCRITURA
       GET DIAGNOSTICS v_escritos = ROW_COUNT;           -- mide la ESCRITURA

   Este test lee los `0*.sql` de `supabase/schema-history` como TEXTO y falla si
   encuentra la forma invertida en cualquier guarda. Ningún valor está
   hardcodeado: los archivos se leen del disco. No se habla con la base.

   POR QUÉ `schema-history` Y NO `migrations`: el squash de la serie dejó
   `supabase/migrations` con un único archivo (`001_orabella_schema.sql`), y los
   76 archivos de la serie se movieron intactos a `supabase/schema-history`. Este
   guardián está escrito sobre la SERIE —busca el defecto que la 060 corrige,
   archivo por archivo—, así que lee el historial: es donde los 76 siguen
   teniendo los mismos nombres, y el barrido mide exactamente lo que medía.
   La guarda de que el archivo único siga siendo el único la lleva el bloque
   del squash en `hardening.test.ts`, que sí mira `supabase/migrations`.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();
const MIGRATIONS_DIR = join(APP_ROOT, "supabase", "schema-history");
const DIAGNOSTICS_PATH = join(APP_ROOT, "supabase", "diagnostics", "migraciones_faltantes.sql");

/** El SQL sin comentarios: la detección mira sentencias, no prosa ni marcadores. */
function stripSqlComments(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/**
 * Forma INVERTIDA de una red de conteo: la sentencia que termina justo antes de
 * `GET DIAGNOSTICS <var> = ROW_COUNT;` es un `SELECT ... INTO` (que deja
 * `ROW_COUNT` en 1 y hace que la guarda mida ese `SELECT`). Devuelve el texto de
 * cada guarda invertida; un arreglo vacío significa que ninguna lo está.
 */
function findInvertedGuards(sql: string): string[] {
  const found: string[] = [];
  const guard = /\bGET DIAGNOSTICS\s+\w+\s*=\s*ROW_COUNT\s*;/gi;
  let match: RegExpExecArray | null;
  while ((match = guard.exec(sql)) !== null) {
    const end = sql.lastIndexOf(";", match.index - 1);
    if (end < 0) continue;
    const start = sql.lastIndexOf(";", end - 1);
    const previousStatement = sql.slice(start + 1, end + 1);
    if (/^\s*SELECT\b[\s\S]*\bINTO\b/i.test(previousStatement)) {
      found.push(previousStatement.trim().replace(/\s+/g, " "));
    }
  }
  return found;
}

function readText(...segments: string[]): string {
  return readFileSync(join(...segments), "utf8");
}

const MIGRATION_NAMES = readdirSync(MIGRATIONS_DIR).filter((f) => /^0\d\d_.*\.sql$/.test(f));

/**
 * Margen para las pruebas que LEEN el disco.
 *
 * Estas pruebas abren los 76 archivos de `supabase/schema-history` de forma
 * síncrona. El guardián es rápido: la prueba más pesada mide 16 ms con la máquina
 * descargada y ~47 ms con el dev cargado, y el mismo recorrido sobre los 69
 * archivos, medido por fuera, da ~2 ms. El límite por defecto de vitest (5000 ms
 * por prueba) no está midiendo al guardián sino a la MÁQUINA: con un `next dev`
 * compilando al lado, la lectura del disco se estira y una prueba sana se reporta
 * como caída por tiempo.
 *
 * Por eso el margen es explícito y generoso: 30 s contra ~47 ms medidos son más
 * de tres órdenes de magnitud de holgura. Lo que se amplía es la ESPERA, no la
 * comparación: las aserciones son las mismas, una regresión real del detector
 * sigue fallando por comparación, y un disco que de verdad se cuelga sigue
 * fallando a los 30 s.
 */
const FILE_SCAN_TIMEOUT_MS = 30_000;

/** Las tres guardas corregidas de la emisión: el COUNT y la ESCRITURA que mide. */
const GUARD_PAIRS: ReadonlyArray<{ count: string; insert: string }> = [
  { count: "SELECT jsonb_array_length(p_items) INTO v_esperados;", insert: "INSERT INTO public.invoice_items" },
  { count: "SELECT jsonb_array_length(p_taxes) INTO v_esperados;", insert: "INSERT INTO public.invoice_taxes" },
  { count: "SELECT jsonb_array_length(p_payments) INTO v_esperados;", insert: "INSERT INTO public.invoice_payments" },
];

describe("orden de las redes de conteo (ROW_COUNT) en las migraciones 0xx", () => {
  it("piso anti-vacío: hay migraciones para revisar y están las dos del fix", () => {
    expect(MIGRATION_NAMES.length).toBeGreaterThan(40);
    expect(MIGRATION_NAMES).toContain("052_invoice_create_atomic.sql");
    expect(MIGRATION_NAMES).toContain("060_fix_invoice_create_guards.sql");
  });

  it("ninguna guarda de ROW_COUNT queda separada de su escritura por un SELECT ... INTO", () => {
    const offenders: string[] = [];
    for (const name of MIGRATION_NAMES) {
      const hits = findInvertedGuards(stripSqlComments(readText(MIGRATIONS_DIR, name)));
      for (const hit of hits) offenders.push(`${name}: ${hit}`);
    }
    // Si esto falla, hay un archivo con la guarda invertida: el mensaje nombra
    // el archivo y la sentencia culpable.
    expect(offenders).toEqual([]);
  }, FILE_SCAN_TIMEOUT_MS);

  it("el detector CAZA la forma vieja de 052 (prueba positiva del guardián)", () => {
    // Recorte verbatim del defecto: el `SELECT ... INTO` metido entre el INSERT
    // y el GET DIAGNOSTICS. Si el detector no lo marca, no protege nada.
    const oldShape = [
      "INSERT INTO public.invoice_items (invoice_id) VALUES (v_factura.id);",
      "",
      "SELECT jsonb_array_length(p_items) INTO v_esperados;",
      "",
      "GET DIAGNOSTICS v_escritos = ROW_COUNT;",
    ].join("\n");
    const hits = findInvertedGuards(oldShape);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("jsonb_array_length(p_items) INTO v_esperados");
  });

  it("no marca la forma corregida (control negativo del guardián)", () => {
    const fixedShape = [
      "SELECT jsonb_array_length(p_items) INTO v_esperados;",
      "",
      "INSERT INTO public.invoice_items (invoice_id) VALUES (v_factura.id);",
      "",
      "GET DIAGNOSTICS v_escritos = ROW_COUNT;",
    ].join("\n");
    expect(findInvertedGuards(fixedShape)).toEqual([]);
  });

  it("052 y 060 ponen el COUNT antes del INSERT en las tres guardas, con el marcador", () => {
    for (const name of ["052_invoice_create_atomic.sql", "060_fix_invoice_create_guards.sql"]) {
      const raw = readText(MIGRATIONS_DIR, name);
      // El marcador estable viaja en comentario: cuenta sólo las líneas que son
      // EXACTAMENTE el marcador (la prosa de 060 también lo cita).
      const markerLines = raw
        .split("\n")
        .filter((line) => line.trim() === "-- fix-060: esperados ANTES del INSERT").length;
      expect(markerLines, name).toBe(3);

      const sql = stripSqlComments(raw);
      for (const { count, insert } of GUARD_PAIRS) {
        const countAt = sql.indexOf(count);
        const insertAt = sql.indexOf(insert);
        expect(countAt, `${name} :: ${count}`).toBeGreaterThan(-1);
        expect(insertAt, `${name} :: ${insert}`).toBeGreaterThan(-1);
        // El conteo se ejecuta ANTES de la escritura...
        expect(countAt, `${name} :: orden`).toBeLessThan(insertAt);
        // ...y el `GET DIAGNOSTICS` que lo mide viene DESPUÉS de la escritura.
        const afterInsert = sql.slice(insertAt);
        expect(afterInsert, `${name} :: diagnostico`).toContain("GET DIAGNOSTICS v_escritos = ROW_COUNT;");
      }
    }
  }, FILE_SCAN_TIMEOUT_MS);

  it("el diagnóstico de migraciones reconoce la 060 por el marcador del cuerpo", () => {
    const diagnostics = readText(DIAGNOSTICS_PATH);
    // Una fila para la 060 con el mecanismo `functiondef` de 055/059.
    expect(diagnostics).toMatch(/\('060',\s*'functiondef'/);
    expect(diagnostics).toContain("'fix-060'");
  }, FILE_SCAN_TIMEOUT_MS);
});

/* --------------------------------------------------------------------------
   El índice único del borrador y el cubo de cadencia (078).

   `payroll_periods` lleva dos garantías que, sin la cadencia, se contradicen:

     * `ex_payroll_periods_no_overlap` (exclusión de 035, reemplazada por 063 y
       reescrita por 074) prohíbe dos períodos con días en común SOLO dentro del
       mismo cubo `coalesce(frequency, '')`. Ciclos distintos que se superponen
       son la regla del dueño, no un defecto.
     * `uq_payroll_draft_per_range` (007, reescrito por 074) era
       `UNIQUE (start_date, end_date) WHERE status = 'borrador'`: SIN cadencia,
       y por lo tantoERA la garantía fuerte que la anterior cuida dejar floja.

   El primer ciclo de cada cadencia se recorta al arranque de la nómina (F10) y
   todas las cadencias cierran en sábado, así que los tres primeros ciclos de la
   instalación comparten el MISMO par de fechas: el índice sin cadencia rechazaba
   con `23505` —`PERIOD_DRAFT_EXISTS`— liquidaciones que la exclusión declara
   legítimas. La 078 mete el cubo como TERCER elemento del índice y las dos
   garantías vuelven a decir lo mismo.

   El guardián lee el archivo como TEXTO, igual que el de arriba: no hay `psql`
   ni conexión, así que lo que mide es la FORMA de la declaración —el nombre, la
   tabla y las TRES claves, en orden— y no su efecto en el catálogo. Es una
   prueba estructural a propósito, no una prueba de DDL disfrazada.
   -------------------------------------------------------------------------- */

/** El archivo que devuelve el cubo de cadencia al índice único del borrador. */
const CADENCE_INDEX_MIGRATION = "078_payroll_draft_unique_per_cadence.sql";

describe("el índice único del borrador de nómina y el cubo de cadencia (078)", () => {
  it("el índice recreado se apoya en start_date, end_date y coalesce(frequency, '')", () => {
    const path = join(MIGRATIONS_DIR, CADENCE_INDEX_MIGRATION);
    // Lectura TOLERANTE a propósito (el patrón de 5.5 del README del squash): en
    // RED el archivo todavía no existe, y el fallo tiene que ser la ASERCION de
    // abajo —que nombra la definición que falta—, no un ENOENT que se lleve por
    // delante el resto del bloque. Las aserciones positivas de más abajo son el
    // piso: sobre texto vacío no pueden pasar.
    const sql = existsSync(path)
      ? stripSqlComments(readText(MIGRATIONS_DIR, CADENCE_INDEX_MIGRATION)).replace(/\s+/g, " ").trim()
      : "";

    // El índice viejo tiene que SALTAR antes de volver a declararse: sin el
    // `DROP`, el `CREATE` del mismo nombre falla con 42P07.
    expect(sql).toContain("DROP INDEX IF EXISTS public.uq_payroll_draft_per_range");

    // La declaración recreada, con su MISMO nombre elegido a mano y sus tres
    // claves: las dos fechas y el cubo de cadencia, que es la misma expresión
    // que `ex_payroll_periods_no_overlap` compara con `=`.
    const declaracion = /CREATE UNIQUE INDEX uq_payroll_draft_per_range[\s\S]*?;/.exec(sql);
    expect(declaracion, `${CADENCE_INDEX_MIGRATION} :: CREATE`).not.toBeNull();
    const indice = declaracion?.[0] ?? "";

    expect(indice).toContain("ON public.payroll_periods USING btree");
    expect(indice).toContain("USING btree (start_date, end_date, coalesce(frequency, ''))");
    // El `WHERE` es el de 007 y no se toca: lo que cambia es la clave, no el
    // alcance — la garantía sigue siendo sobre borradores.
    expect(indice).toContain("WHERE (status = 'borrador')");

    // La forma VIEJA, la que la 078 viene a quitar. Sin este control negativo la
    // prueba de arriba seguiría siendo cierta si el archivo declarara el índice
    // dos veces: la buena sin cadencia, y la de cadencia después.
    expect(indice).not.toMatch(/\(start_date, end_date\)\s+WHERE/);
  }, FILE_SCAN_TIMEOUT_MS);
});
