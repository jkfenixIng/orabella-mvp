import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

/* --------------------------------------------------------------------------
   Guardas de los headers de seguridad HTTP (W2).

   Por qué existe: next.config.ts se enviaba vacío, así que la app no declaraba
   NINGÚN header de seguridad. Sobre un panel de administración con acciones
   destructivas eso deja cuatro huecos conocidos: clickjacking
   (X-Frame-Options), sniffing de MIME (X-Content-Type-Options), degradación a
   HTTP (Strict-Transport-Security) y fuga del referrer (Referrer-Policy).

   Test offline y determinista: importa el config REAL y ejecuta su headers() en
   memoria (mismo patrón de casa que tests/design-tokens.test.ts y
   tests/action-guards.test.ts). Sin red, sin mocks, sin levantar el server.

   LÍMITE EXPLÍCITO: esto prueba que el config DECLARA estos headers. NO prueba
   que una respuesta HTTP real los emita; verlo en vuelo exige levantar el
   server, que este work unit deliberadamente no hace.
   -------------------------------------------------------------------------- */

type HeaderPair = { key: string; value: string };
type HeaderRule = { source: string; headers: HeaderPair[] };

/** Source catch-all: alcanza todas las rutas de la app. */
const CATCH_ALL_SOURCE = "/(.*)";

/** Valores EXACTOS exigidos. No flexibilizar sin una decisión explícita. */
const REQUIRED_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
};

/**
 * Headers deliberadamente AUSENTES, con el motivo de cada omisión. Si alguien
 * los agrega, este test falla y lo obliga a justificar la decisión en lugar de
 * colarla como efecto colateral.
 */
const FORBIDDEN_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "una CSP mal calibrada rompe la app y las suites e2e de Playwright, y este proyecto prohíbe cambios que limiten el testing.",
  "Permissions-Policy":
    "la app puede depender de capacidades del navegador (cámara, micrófono, geolocalización) y desactivarlas en bloque no es una suposición segura.",
};

/** Ejecuta el headers() real del config. Si no está declarado, FALLA. */
async function readHeaderRules(): Promise<HeaderRule[]> {
  const declared = nextConfig.headers;

  expect(typeof declared, "next.config.ts debe declarar una función headers()").toBe("function");
  if (typeof declared !== "function") {
    // Inalcanzable: el expect de arriba ya lanzó. Guard solo para TypeScript.
    throw new Error("next.config.ts no declara headers()");
  }

  const rules = await declared();

  expect(Array.isArray(rules), "headers() debe devolver un arreglo de reglas").toBe(true);
  expect(rules.length, "headers() no declara ninguna regla de headers").toBeGreaterThan(0);

  return rules as HeaderRule[];
}

/** Devuelve la entrada catch-all; falla si no existe. */
function readCatchAllRule(rules: HeaderRule[]): HeaderRule {
  const rule = rules.find((candidate) => candidate.source === CATCH_ALL_SOURCE);

  expect(
    rule,
    `headers() debe declarar una entrada con el source catch-all ${CATCH_ALL_SOURCE}`,
  ).toBeDefined();

  return rule as HeaderRule;
}

/** Valor declarado para una clave exacta, o undefined. */
function readHeaderValue(rule: HeaderRule, key: string): string | undefined {
  return rule.headers.find((header) => header.key === key)?.value;
}

/**
 * Precondición positiva compartida: devuelve la lista de headers requeridos
 * que faltan o cuyo valor no es el exigido. Vacía === el rule está completo.
 *
 * Existe porque los tests de omisión deliberada solo miraban AUSENCIA: si
 * alguien vaciaba `headers` o renombraba los cuatro headers, la omisión se
 * cumplía trivialmente y el test seguía pasando. Ahora la omisión se exige
 * DESPUÉS de comprobar esta precondición, así que vaciar la lista también
 * rompe los tests de omisión.
 */
function missingRequiredHeaders(rule: HeaderRule): string[] {
  const missing: string[] = [];

  for (const [key, value] of Object.entries(REQUIRED_HEADERS)) {
    const declared = readHeaderValue(rule, key);
    if (declared !== value) {
      missing.push(`${key}: se esperaba \`${value}\` y se leyó \`${declared ?? "(ausente)"}\``);
    }
  }

  return missing;
}

describe("headers de seguridad en next.config.ts", () => {
  it("declara una función headers() asíncrona", () => {
    const declared = nextConfig.headers;

    expect(typeof declared, "next.config.ts debe declarar headers()").toBe("function");
    if (typeof declared !== "function") {
      return;
    }

    expect(declared.constructor.name, "headers() debe ser una función async").toBe("AsyncFunction");
  });

  it("aplica los cuatro headers exactos bajo el source catch-all /(.*)", async () => {
    const rules = await readHeaderRules();
    const rule = readCatchAllRule(rules);

    for (const [key, value] of Object.entries(REQUIRED_HEADERS)) {
      expect(readHeaderValue(rule, key), `${key}: ausente o con un valor inesperado`).toBe(value);
    }
  });

  it("NO declara Content-Security-Policy (omisión deliberada)", async () => {
    const rules = await readHeaderRules();
    const rule = readCatchAllRule(rules);

    // Precondición positiva PRIMERO: el catch-all debe declarar los cuatro
    // headers requeridos con sus valores exactos. Sin esto, un `headers: []` o
    // un renombre masivo haría pasar la omisión de forma vacua.
    const missing = missingRequiredHeaders(rule);
    expect(
      missing,
      `precondición positiva: el catch-all ${CATCH_ALL_SOURCE} debe declarar los cuatro headers requeridos antes de exigir la omisión: ${missing.join("; ")}`,
    ).toEqual([]);

    const present = rules.flatMap((candidate) =>
      candidate.headers.filter((header) => header.key.toLowerCase() === "content-security-policy"),
    );

    // Deliberado: una CSP mal calibrada rompe la app y las suites e2e de
    // Playwright, y este proyecto prohíbe cambios que limiten el testing.
    // Agregarla debe ser una decisión explícita, no un efecto colateral.
    expect(
      present,
      `Content-Security-Policy no debe declararse todavía: ${FORBIDDEN_HEADERS["Content-Security-Policy"]}`,
    ).toEqual([]);
  });

  it("NO declara Permissions-Policy (omisión deliberada)", async () => {
    const rules = await readHeaderRules();
    const rule = readCatchAllRule(rules);

    // Precondición positiva PRIMERO (ver el test de CSP).
    const missing = missingRequiredHeaders(rule);
    expect(
      missing,
      `precondición positiva: el catch-all ${CATCH_ALL_SOURCE} debe declarar los cuatro headers requeridos antes de exigir la omisión: ${missing.join("; ")}`,
    ).toEqual([]);

    const present = rules.flatMap((candidate) =>
      candidate.headers.filter((header) => header.key.toLowerCase() === "permissions-policy"),
    );

    // Deliberado: la app puede depender de capacidades del navegador (cámara,
    // micrófono, geolocalización). Desactivarlas en bloque no es una suposición
    // segura; requiere inventario previo de uso real.
    expect(
      present,
      `Permissions-Policy no debe declararse todavía: ${FORBIDDEN_HEADERS["Permissions-Policy"]}`,
    ).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
   Self-tests de la precondición positiva: prueban, con un rule sintético, que
   el helper compartido rechaza una lista de headers vacía o renombrada. Son la
   evidencia de que los tests de omisión de arriba ya no pueden pasar en vacío.
   -------------------------------------------------------------------------- */

describe("precondición positiva de los headers requeridos", () => {
  it("rechaza un catch-all con `headers: []`", () => {
    const missing = missingRequiredHeaders({ source: CATCH_ALL_SOURCE, headers: [] });

    expect(missing.length, `un rule sin headers debe reportar los cuatro faltantes: ${missing.join("; ")}`).toBe(
      Object.keys(REQUIRED_HEADERS).length,
    );
  });

  it("rechaza los cuatro headers renombrados con valores exactos pero claves distintas", () => {
    const renamed = Object.entries(REQUIRED_HEADERS).map(([key, value]) => ({
      key: `X-Renamed-${key}`,
      value,
    }));
    const missing = missingRequiredHeaders({ source: CATCH_ALL_SOURCE, headers: renamed });

    expect(missing.length, missing.join("; ")).toBe(Object.keys(REQUIRED_HEADERS).length);
  });
});
