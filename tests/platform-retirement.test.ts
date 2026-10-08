import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "@/src/shared/lib/audit";
import { roleCodeSchema, SEDE_ASSIGNABLE_ROLES } from "@/src/features/auth/schemas";

/* --------------------------------------------------------------------------
   U12 — RETIRO DE LA CAPA DE PLATAFORMA.

   La capa `/plataforma` + `src/features/platform` + `scripts/create-superadmin`
   se retiró por decisión del dueño («del 1 si no hace nada eliminarlo»): su
   única escritura era la fecha de arranque de la nómina y esa configuración ya
   no existe (ahora la declara el PRIMER settlement y se deriva del período más
   antiguo).

   Este archivo es el CIERRE de ese retiro, con el mismo patrón de casa que los
   demás tests de fuente (`tests/action-guards.test.ts`,
   `tests/middleware-matcher.test.ts`): lee el repo real, sin red y sin Supabase.
   Un test de comportamiento NO puede probar que un archivo dejó de existir, así
   que la ausencia se comprueba sobre el disco.

   Lo que este archivo fija, y que sobrevive a la retirement:

   1. La capa no está: ni la pantalla, ni el servicio, ni el script.
   2. NADA la importa: ni un módulo, ni una prueba. Un `import` roto es un
      `next build` roto, y una ruta que nadie ve ya no está retirada.
   3. La aplicación no la ofrece: ni el nav, ni la tarjeta del inicio, ni
      ninguna ruta enlaza `/plataforma`.
   4. El vocabulario cerrado de auditoría no declara ninguna acción `platform.*`.
      Precedente exacto en el repo: `platform.sede_created` y
      `platform.sede_roles_set` se retiraron del vocabulario cuando ya no había
      operación que auditar, DEJANDO INTACTAS las filas históricas de
      `audit_logs`. Aquí se repite el patrón con `platform.payroll_start_date_set`.
   5. La DEUDA declarada en la base sigue declarada: el rol `superadmin` y la
      columna `sedes.payroll_start_date`. Retirar el código NO borra la fila ni
      regenera el esquema: eso es otra unidad, con su migración.
   6. La COPIA ya no promete una plataforma: el bloque U13 de más abajo.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();

/** Raíces de código de la aplicación (los tests se auditan aparte). */
const SOURCE_ROOTS = ["src", "app"] as const;

function toRepoPath(absolute: string): string {
  return relative(APP_ROOT, absolute).split("\\").join("/");
}

/** Todos los `.ts`/`.tsx` bajo una raíz, en orden estable. */
function sourceFiles(root: string): string[] {
  const start = join(APP_ROOT, root);
  if (!existsSync(start)) return [];
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        // `app/api/v1/*` sí es código; las carpetas que Next/Playwright generan
        // no son fuente y se saltan para que el guard no dependa de ellas.
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(absolute);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        found.push(toRepoPath(absolute));
      }
    }
  };
  walk(start);
  return found;
}

/** Los mismos archivos de código, en pares `{ archivo, fuente }`. */
function codeSources(): Array<{ file: string; source: string }> {
  return SOURCE_ROOTS.flatMap((root) => sourceFiles(root)).map((file) => ({
    file,
    source: readFileSync(join(APP_ROOT, file), "utf8"),
  }));
}

/**
 * Código SIN comentarios: una guarda o un símbolo CITADO al explicar el retiro
 * no es una dependencia (mismo criterio que `stripComments` en
 * `tests/action-guards.test.ts`). Los literales NO se tocan: un `href` es código.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * ¿Algún código menciona el predicado?
 *
 * Se lee el CÓDIGO: los comentarios no cuentan, porque documentar el retiro
 * («la capa `src/features/platform` ya no existe») es lo contrario de depender
 * de él. Los comentarios que quedan fuera de las superficies de esta unidad
 * están reportados como deuda documental en el traspaso.
 */
function mentions(
  needle: string,
  haystack: string[] = codeSources().map((entry) => entry.source),
): string[] {
  return haystack.filter((source) => stripComments(source).includes(needle));
}

describe("U12: la capa de plataforma está retirada", () => {
  it("no existen ni la pantalla ni el servicio ni el script", () => {
    const retirado = [
      "app/plataforma",
      "app/plataforma/page.tsx",
      "app/plataforma/plataforma-client.tsx",
      "src/features/platform",
      "src/features/platform/service.ts",
      "src/features/platform/actions.ts",
      "scripts/create-superadmin.ts",
    ];
    const presentes = retirado.filter((ruta) => existsSync(join(APP_ROOT, ruta)));
    expect(presentes, `la capa de plataforma sigue en disco: ${presentes.join(", ")}`).toEqual([]);
  });

  it("ningún módulo importa la capa de plataforma", () => {
    const importadores = mentions("features/platform").filter((source) =>
      /from\s+["'][^"']*features\/platform/.test(source),
    );
    expect(importadores, "un módulo sigue importando la capa retirada").toEqual([]);
    // Control negativo: el predicado distingue un import real de una mención.
    expect(
      mentions("features/platform", [
        'import { requirePlatformAdmin } from "@/src/features/platform/service";',
      ]).length,
    ).toBe(1);
    expect(mentions("features/platform", ["// la capa features/platform ya no existe"])).toEqual([]);
  });

  it("ningún módulo nombra los símbolos que sólo la capa usaba", () => {
    const retiring = [
      "requirePlatformAdmin",
      "setPlatformPayrollStartDate",
      "readPlatformInstallation",
      "leerSedeDeLaInstalacion",
      "PlatformActor",
      "PlatformInstallationRow",
      "PlataformaPayrollStartDateForm",
    ];
    const sources = codeSources();
    for (const symbol of retiring) {
      expect(mentions(symbol, sources.map((entry) => entry.source)), `queda \`${symbol}\``).toEqual(
        [],
      );
    }
    // Control negativo: el predicador no es una comprobación de goma.
    expect(mentions("requirePlatformAdmin", ["await requirePlatformAdmin(token);"])).toHaveLength(1);
    // Y un símbolo sólo CITADO en un comentario no cuenta como dependencia.
    expect(mentions("requirePlatformAdmin", ["// requirePlatformAdmin(token)"])).toEqual([]);
  });

  it("ninguna ruta de la aplicación enlaza `/plataforma`", () => {
    expect(mentions("/plataforma"), "queda una ruta o un enlace a `/plataforma`").toEqual([]);
    // Control negativo: el predicador distingue el href de una palabra suelta.
    expect(mentions("/plataforma", ['href: "/plataforma"'])).toHaveLength(1);
    expect(mentions("/plataforma", ["la palabra plataforma sola"])).toEqual([]);
  });

  it("ni el nav ni el inicio ofrecen la entrada de plataforma", () => {
    const nav = readFileSync(join(APP_ROOT, "src/shared/components/main-nav.tsx"), "utf8");
    const inicio = readFileSync(join(APP_ROOT, "app/page.tsx"), "utf8");

    // El rol `superadmin` no authorize nada: no queda ninguna superficie que lo use.
    expect(nav).not.toContain("superadmin");
    expect(inicio).not.toContain("superadmin");
    // Y el grupo que sólo la sostenía tampoco: el nav no declara un grupo vacío.
    expect(nav).not.toContain('id: "instalacion"');
  });

  it("el vocabulario de auditoría no declara ninguna acción de plataforma", () => {
    // Precedente del repo: una acción sale del vocabulario cerrado cuando ya no
    // hay operación que auditar. Las filas YA escritas en `audit_logs` con esos
    // valores NO se tocan: el registro histórico no se reescribe.
    const dePlataforma = Object.entries(AUDIT_ACTIONS).filter(([, action]) =>
      action.startsWith("platform."),
    );
    expect(
      dePlataforma.map(([clave, action]) => `${clave}: ${action}`),
      "queda una acción de plataforma en el vocabulario cerrado",
    ).toEqual([]);
    // Los tres nombres retirados, uno por uno (incluidos los dos anteriores).
    for (const nombre of [
      "platform.sede_created",
      "platform.sede_roles_set",
      "platform.payroll_start_date_set",
    ]) {
      expect(Object.values(AUDIT_ACTIONS), `el vocabulario declara ${nombre}`).not.toContain(nombre);
    }
    // Control negativo: la aserción no es de goma (el resto del vocabulario sigue).
    expect(Object.values(AUDIT_ACTIONS)).toContain("payroll.calculated");
  });

  it("no queda el script de aprovisionamiento ni su script de npm", () => {
    const packageJson = JSON.parse(
      readFileSync(join(APP_ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(Object.keys(packageJson.scripts)).not.toContain("create:superadmin");
    // El resto de los scripts de npm sigue en pie.
    expect(Object.keys(packageJson.scripts)).toContain("typecheck");
  });

  it("ninguna prueba importa lo retirado", () => {
    const pruebas: string[] = [];
    const collect = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "e2e") collect(absolute);
        } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
          pruebas.push(toRepoPath(absolute));
        }
      }
    };
    collect(join(APP_ROOT, "tests"));
    expect(pruebas.length, "no se encontraron pruebas unitarias").toBeGreaterThan(0);

    const importar = /from\s+["'][^"']*(features\/platform|scripts\/create-superadmin)["']/;
    const culpable = pruebas.filter((file) =>
      importar.test(readFileSync(join(APP_ROOT, file), "utf8")),
    );
    expect(culpable, `pruebas que importan la capa retirada: ${culpable.join(", ")}`).toEqual([]);
  });
});

describe("U12: la base NO se toca (deuda declarada)", () => {
  const SCHEMA = "supabase/migrations/001_orabella_schema.sql";

  it("el rol `superadmin` sigue declarado en el catálogo de la base", () => {
    const esquema = readFileSync(join(APP_ROOT, SCHEMA), "utf8");
    // Retirar la capa NO elimina el rol: hacerlo obligaría a regenerar el
    // archivo único de esquema y a resetear las dos bases.
    expect(esquema).toContain("'superadmin'::text");
    // Y en el código, el espejo del catálogo: existe como rol, y el admin de la
    // sede NO lo puede asignar.
    expect(roleCodeSchema.options).toContain("superadmin");
    expect(SEDE_ASSIGNABLE_ROLES).not.toContain("superadmin");
  });

  it("la columna `sedes.payroll_start_date` sigue declarada y sin uso", () => {
    const esquema = readFileSync(join(APP_ROOT, SCHEMA), "utf8");
    expect(esquema).toMatch(/^\s*payroll_start_date date$/m);
    // Sin uso en el código: ya no hay quien la escriba ni la lea.
    expect(mentions("payroll_start_date")).toEqual([]);
    // Control negativo: el predicado no es de goma (el módulo de nómina sí
    // nombra su propio equivalente, que es otro símbolo).
    expect(mentions("payroll_start_date", ["const x = 'payroll_start_date';"])).toHaveLength(1);
  });

  it("el archivo de esquema existe donde el guard dice que está", () => {
    expect(statSync(join(APP_ROOT, SCHEMA)).isFile()).toBe(true);
  });
});

/* --------------------------------------------------------------------------
   U13 — LA COPIA QUE EL RETIRO DEJÓ MENTIRA.

   U12 se llevó las SUPERFICIES de la plataforma; los TEXTOS quedaron, porque
   viven en otras unidades. Tres frases quedaron prometiendo un "desde la
   plataforma" que ya no existe: la más grave es el mensaje de `AdminError` que
   `setUserRoles` lanza —lo lee una persona en la pantalla de usuarios cuando
   intenta asignar `superadmin`—, y las otras dos son comentarios que describen
   como si existiera la puerta que ya no está.

   La verdad que la copia tiene que decir, y que es la que el código hace:
   `superadmin` existe en el catálogo de la base (deuda declarada) y NINGUNA
   superficie de la aplicación lo otorga ni lo quita. `setUserRoles` sigue
   rechazando las dos direcciones, con el mismo código y el mismo estado: esto
   cambia la FRASE, no la puerta.

   Lo que este bloque fija:

   1. Ninguna de las tres frases falsas sobrevive, y el alcance son las tres
      superficies donde viven, comentarios INCLUIDOS: un comentario que miente
      sigue mintiéndole al próximo que lo lea.
   2. El mensaje al usuario dice la verdad del código, en las DOS guardas
      (otorgar y quitar), con un solo literal: dos redacciones distintas del
      mismo hecho es una forma de volver a mentir por dentro.
   3. La mitad que era CIERTA sigue presente en las tres superficies: el rol
      existe en el catálogo y no se asigna desde una sede. Quitar la mentira no
      puede costar la verdad.

   El alcance es a propósito: los archivos de las copy-sweeps que corren en
   paralelo (payroll, vales, cash, invoices, inventory) no entran. Esta guarda no
   es dueña de esos textos y no puede afirmar por ellos.
   -------------------------------------------------------------------------- */

/** Superficies donde quedó la copia que nombra a una plataforma que se retiró. */
const SUPERFICIES_DE_LA_COPIA = [
  "src/features/admin/service.ts",
  "src/features/auth/schemas.ts",
  "app/admin/admin-sections/users-section.tsx",
] as const;

/**
 * Las frases falsas, una por una. En minúsculas y sin el punto final: el
 * ajuste de línea de la prosa no es contrato, así que la comparación va sobre
 * el texto aplastado (`prosa`). La última está en MAYÚSCULAS a propósito, que
 * es como estaba escrita: el grito tampoco se conserva.
 */
const FRASES_FALSAS = [
  "se administra desde la plataforma",
  "lo otorga la plataforma",
  "de PLATAFORMA",
] as const;

/**
 * La prosa con sus espacios aplastados. Antes se quita el `*` de margen del
 * JSDoc: sin eso, una frase partida de ajuste de línea queda con un asterisco en
 * medio y el detector no la ve — una guarda que no puede ver la verdad que
 * afirma no es una guarda.
 */
function prosa(texto: string): string {
  return texto.replace(/^[ \t]*\*[ \t]?/gm, "").replace(/\s+/g, " ");
}

/** El archivo de la aplicación, con la prosa aplastada. */
function prosaDe(archivo: string): string {
  return prosa(readFileSync(join(APP_ROOT, archivo), "utf8"));
}

/** El mensaje que el servicio le muestra a una persona, con el código y estado. */
const MENSAJE_VERDADERO = "El rol superadmin no se puede asignar ni quitar desde la aplicación.";

describe("U13: la copia ya no promete una plataforma que se retiró", () => {
  it("ninguna de las tres frases falsas sobrevive en las superficies de la copia", () => {
    for (const archivo of SUPERFICIES_DE_LA_COPIA) {
      const texto = prosaDe(archivo);
      for (const frase of FRASES_FALSAS) {
        expect(texto.includes(frase), `${archivo} todavía dice «${frase}»`).toBe(false);
      }
    }
    // Control negativo: el predicado no es de goma. Las tres frases se cazan
    // cuando alguien las vuelve a escribir, en prosa y en un literal.
    expect(
      prosa('const m = "El rol de plataforma solo se administra desde la plataforma.";').includes(
        "se administra desde la plataforma",
      ),
    ).toBe(true);
    expect(
      prosa("// `superadmin` queda FUERA: solo lo otorga la plataforma.").includes(
        "lo otorga la plataforma",
      ),
    ).toBe(true);
    expect(prosa("/** `superadmin` es de PLATAFORMA. */").includes("de PLATAFORMA")).toBe(true);
  });

  it("el mensaje al usuario dice la verdad del código, en las DOS guardas", () => {
    const fuente = readFileSync(join(APP_ROOT, "src/features/admin/service.ts"), "utf8");
    // Otorgar (`superadmin` pedido) y quitar (`superadmin` que ya está) rechazan
    // con el MISMO literal: son la misma verdad sobre el mismo rol.
    const ocurrencias = fuente.split(MENSAJE_VERDADERO).length - 1;
    expect(ocurrencias, "el mensaje verdadero no está en las dos guardas").toBe(2);
    // Y NINGÚN mensaje del servicio le promete a una persona una puerta que no
    // existe: se revisan todos los literales de `AdminError` del archivo.
    const mensajes = [
      ...fuente.matchAll(/new AdminError\(\s*"[A-Z_]+",\s*"([^"]*)"/g),
    ].map((encontro) => encontro[1] ?? "");
    expect(mensajes.length, "el detector no encontró mensajes que revisar").toBeGreaterThan(5);
    expect(
      mensajes.filter((mensaje) => mensaje.toLowerCase().includes("plataforma")),
      "un mensaje al usuario sigue nombrando a la plataforma",
    ).toEqual([]);
  });

  it("la mitad que era CIERTA sigue en las tres superficies", () => {
    // El rol existe en el catálogo de la base…
    expect(prosaDe("src/features/auth/schemas.ts")).toContain(
      "`superadmin` existe en el catálogo (069) para la cuenta del dueño",
    );
    // …y no se asigna ni se quita desde la administración de una sede.
    expect(prosaDe("src/features/auth/schemas.ts")).toContain(
      "NO se asigna ni se quita desde la administración de una sede",
    );
    // La puerta que lo deja FUERA sigue siendo el esquema asignable de sede.
    expect(prosaDe("src/features/auth/schemas.ts")).toContain("sedeAssignableRoleSchema");
    // Y la pantalla sigue dejando de ofrecerlo, con la misma explicación.
    expect(prosaDe("app/admin/admin-sections/users-section.tsx")).toContain(
      "no se otorga ni se quita desde una sede",
    );
  });
});
