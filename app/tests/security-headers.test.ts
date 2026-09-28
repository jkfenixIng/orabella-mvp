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
    const present = rules.flatMap((rule) =>
      rule.headers.filter((header) => header.key.toLowerCase() === "content-security-policy"),
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
    const present = rules.flatMap((rule) =>
      rule.headers.filter((header) => header.key.toLowerCase() === "permissions-policy"),
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
