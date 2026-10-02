import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------------
   Guarda de adopción del `Badge` (WU4).

   Medido en el árbol antes de este WU:
     - `src/components/ui/lib/badge.tsx` existía y se usaba UNA vez
       (`app/inventory/inventory-client.tsx`, "Bajo mínimo").
     - Las pastillas de estado estaban escritas a mano en 8 sitios, con TRES
       grafías distintas de la misma forma:
         a) `rounded-full px-2 py-0.5 text-xs font-semibold` + paleta cruda con
            override `dark:` (el helper local `statusPill`),
         b) `rounded-full px-2 py-0.5 text-xs font-semibold` + paleta cruda SIN
            override (los chips del papel de factura),
         c) `rounded bg-surface-hover px-2 py-0.5 text-xs text-text-secondary`
            (los chips neutros de nómina y caja).
     WU4 convirtió los que expresan un estado al primitivo y dejó uno solo:
     el contador de alertas no leídas del nav, que es deliberadamente sólido y
     ruidoso (ver ALLOWLIST).

   Qué afirma esta guarda:
     1. Ninguna superficie compone una pastilla a mano (detector de dos firmas).
     2. Cada sitio convertido usa `Badge`, con la variante declarada.
     3. El mapeo de estado de factura existe y cubre los tres estados.
     4. Piso anti-vacío: si el walk de superficies se rompe, la guarda falla
        en vez de pasar sola.

   POR QUÉ TOKENS Y NO SUBSTRINGS: este repo se quemó dos veces con grep de
   substring (`text-text-primary` termina en `text-primary`; `border-border`
   matchea `border-border-color`). Acá TODO se compara como token completo:
   los tokens de clase salen de un tokenizador y se comparan por igualdad, y
   las etiquetas `<Badge` exigen un delimitador después del identificador, así
   que `<BadgeCustom>` no cuenta.

   LÍMITES HONESTOS DEL DETECTOR (no es un parser de JS):
     - Se borran comentarios `//` y `/* *\/` antes de contar, porque los
       archivos existentes nombran estas clases al explicarlas. El borrado es
       naïf (un `//` dentro de un literal lo cortaría); en estas superficies no
       hay URLs ni `//` dentro de strings.
     - Se miran literales de string (comilla doble, simple y backtick) y se
       tokenizan; no se interpreta la interpolación `${...}`. Los literales que
       no son `class` (copys, claves) pasan por el detector sin hallazgos.
     - La firma "pastilla" solo reconoce los dos redondeos que este código usa
       para pastillas (`rounded`, `rounded-full`). Un chip futuro con
       `rounded-md`/`rounded-lg` + `bg-` + `px-2` NO sería detectado por
       ninguna de las dos firmas: es un falso NEGATIVO acotado y documentado,
       no un falso positivo silencioso. Ampliar `PILL_RADIUS` cubriría ese
       caso, pero también empezaría a marcar botones (`rounded-md … px-4`) si
       no se ajusta el padding.
     - No recorre `tests/`, igual que `no-raw-palette.test.ts` y
       `format.test.ts`: este archivo nombra las clases al explicarlas.

   FUERA DE ALCANCE (declarado, no olvidado): `app/vales/vouchers-client.tsx:507`
   tiene el mismo chip neutro (`rounded bg-surface-hover px-2 py-0.5
   text-xs text-text-secondary`) que WU4 convirtió en nómina y caja. No está
   en las superficies de WU4 y por eso no está en `SURFACES`: convertirlo sin
   tocar `tests/no-raw-palette.test.ts` no fallaría, y la guarda no puede
   fingir que lo cubre.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();

/** Superficies de WU4, relativas al cwd (`app/`), con `/` siempre. */
const SURFACES = [
  "app/invoices/invoices-client.tsx",
  "app/payroll/payroll-client.tsx",
  "app/cash/cash-client.tsx",
  "src/shared/components/main-nav.tsx",
];

/**
 * Piso anti-vacío. El archivo más chico de las cuatro (`main-nav.tsx`, 354
 * líneas) pasa holgadamente los 2000 caracteres; una ruta mal resuelta (cwd
 * distinto) o un archivo vaciado por error falla acá en vez de hacer pasar el
 * detector sobre la nada.
 */
const MIN_SURFACE_LENGTH = 2000;

/** El único sitio que WU4 dejó a mano, con su razón. */
const ALLOWLIST = new Map<string, { hits: number; reason: string }>([
  [
    "src/shared/components/main-nav.tsx",
    {
      hits: 1,
      reason:
        "Contador de alertas sin leer: es un NÚMERO, no el estado de una entidad, y su relleno sólido " +
        "`bg-error` + `text-white` es una decisión deliberada de prominencia (puede quedar sobre la barra " +
        "activa, que es `bg-primary-600` sólida). La variante más fuerte del primitivo, `destructive`, es " +
        "`bg-error-light text-error` (tinte pálido): adoptarla apagaría el aviso en vez de estilizarlo. " +
        "Se deja y se reporta, no se fuerza.",
    },
  ],
]);

/**
 * Sitios convertidos: cuántas etiquetas `<Badge` debe tener el archivo y con
 * qué variantes. `dynamic:identificador` es una variante calculada; el mapeo
 * se afirma aparte (ver `invoiceStatusVariant`).
 */
const CONVERTED: Array<{
  path: string;
  badges: number;
  variants: Map<string, number>;
  note: string;
}> = [
  {
    path: "app/invoices/invoices-client.tsx",
    badges: 7,
    variants: new Map([
      ["dynamic:invoiceStatusVariant", 2],
      ["static:default", 1],
      ["static:secondary", 1],
      ["static:success", 2],
      ["static:warning", 1],
    ]),
    note: "Ambos estados de factura + Borrador + Comisión + Sin comisión + recargo + Total inmutable.",
  },
  {
    path: "app/payroll/payroll-client.tsx",
    badges: 1,
    variants: new Map([["static:secondary", 1]]),
    note: "Estado del período (abierto/cerrado/borrador): el diseño lo expresa neutro, variante `secondary`.",
  },
  {
    path: "app/cash/cash-client.tsx",
    badges: 1,
    variants: new Map([["static:secondary", 1]]),
    note: "Estado del vale (pendiente/descontada): mismo caso neutro que nómina.",
  },
];

/** Identificadores que la adopción debió eliminar (comparación de token completo). */
const REMOVED_HELPERS = ["statusPill"];

/** Redondeos que este código usa para pastillas. `rounded-md` es de botones. */
const PILL_RADIUS = new Set(["rounded", "rounded-full"]);

/** Padding horizontal "de pastilla": el que la primitiva ya aporta. */
const PILL_PADDING = new Set(["px-1", "px-1.5", "px-2", "px-2.5", "px-3"]);

/** Token de clase: variantes (`hover:`), utilidad, y como mucho `/alpha`. */
const CLASS_TOKEN = /[A-Za-z0-9_:./-]+/g;

/** Identificador JS completo (para `statusPill`, no para `statusPill2`). */
function hasWholeIdentifier(source: string, identifier: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_$])${identifier}(?![A-Za-z0-9_$])`).test(source);
}

/** Código sin comentarios: una clase nombrada al EXPLICAR el criterio no es una clase aplicada. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Literales de string del archivo, sin las comillas. Un escáner de estado
 * simple: dentro de un literal se ignora cualquier otra comilla hasta la de
 * cierre del mismo tipo. Los `${...}` de un backtick quedan como texto (sus
 * tokens son ruido inocuo: nunca completan una pastilla por sí solos).
 */
function stringLiterals(source: string): string[] {
  const code = stripComments(source);
  const literals: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < code.length; i += 1) {
    const char = code[i];
    if (quote === null) {
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        start = i + 1;
      }
      continue;
    }
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === quote) {
      literals.push(code.slice(start, i));
      quote = null;
    }
  }
  return literals;
}

/** Utilidad de un token: la variante se corta antes (`dark:hover:bg-x` → `bg-x`). */
function utilityOf(token: string): string {
  return token.split(":").pop() ?? token;
}

/** Tokens de clase de un literal, tal como están escritos. */
function classTokens(literal: string): string[] {
  return [...literal.matchAll(CLASS_TOKEN)].map((match) => match[0]);
}

type PillFinding = { reasons: string[]; classes: string[] };

/**
 * Pastillas escritas a mano. Dos firmas, por separado, porque cada una tapa un
 * caso que la otra no ve:
 *
 *  - `pill-shape`: el literal COMPONE la pastilla (redondeo + padding apretado
 *    + relleno). Es la firma de los chips neutros
 *    (`rounded bg-surface-hover px-2 py-0.5 …`).
 *  - `pill-radius`: el literal usa `rounded-full`. Ese redondeo es del
 *    primitivo: en estas superficies la única razón para escribirlo a mano es
 *    armar una pastilla. Esta firma es la que atrapa una pastilla con el
 *    relleno CALCULADO (el antiguo `statusPill`, que interpolaba `${tone}` y
 *    por eso no tenía ningún `bg-` en su propio literal).
 */
function pillFindings(source: string): PillFinding[] {
  const findings: PillFinding[] = [];
  for (const literal of stringLiterals(source)) {
    const tokens = classTokens(literal);
    if (tokens.length === 0) continue;
    const utilities = tokens.map(utilityOf);
    const hasRadius = utilities.some((utility) => PILL_RADIUS.has(utility));
    const hasPillRadius = utilities.includes("rounded-full");
    const hasPadding = utilities.some((utility) => PILL_PADDING.has(utility));
    const hasBackground = utilities.some((utility) => utility.startsWith("bg-"));
    const reasons: string[] = [];
    if (hasRadius && hasPadding && hasBackground) reasons.push("pill-shape");
    if (hasPillRadius) reasons.push("pill-radius");
    if (reasons.length > 0) findings.push({ reasons, classes: utilities });
  }
  return findings;
}

/** Etiquetas de apertura `<Badge` (el `(?=...)` impide contar `<BadgeCustom`). */
function badgeTags(source: string): string[] {
  return [...stripComments(source).matchAll(/<Badge(?=[\s/>])[\s\S]*?\/?>/g)].map(
    (match) => match[0],
  );
}

/**
 * Ranura de variante de una etiqueta: `static:success`, `dynamic:identificador`
 * o `none` (sin `variant`, el primitivo aplica su default).
 */
function variantSlot(tag: string): string {
  const literal = tag.match(/\bvariant="([^"]*)"/);
  if (literal) return `static:${literal[1]}`;
  const computed = tag.match(/\bvariant=\{([^}]*)\}/);
  if (computed) return `dynamic:${computed[1].trim().split("(")[0]}`;
  return "none";
}

/** Especificadores importados desde el primitivo (token completo, no substring). */
function badgeImportSpecifiers(source: string): string[] {
  const match = stripComments(source).match(
    /import\s*\{([^}]*)\}\s*from\s*"@\/src\/components\/ui\/lib\/badge"/,
  );
  if (!match) return [];
  return match[1]
    .split(",")
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier.length > 0);
}

const SOURCES = new Map<string, string>(
  SURFACES.map((path) => [path, readFileSync(join(APP_ROOT, path), "utf8")]),
);

describe("detector de pastilla a mano: no es un sello de goma", () => {
  it("detecta una pastilla compuesta a mano", () => {
    expect(pillFindings('className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs"')).toEqual([
      { reasons: ["pill-shape", "pill-radius"], classes: ["rounded-full", "bg-emerald-100", "px-2", "py-0.5", "text-xs"] },
    ]);
  });

  it("detecta el chip neutro de otra grafía (`rounded` sin `-full`)", () => {
    expect(
      pillFindings('className="rounded bg-surface-hover px-2 py-0.5 text-xs text-text-secondary"'),
    ).toEqual([
      {
        reasons: ["pill-shape"],
        classes: ["rounded", "bg-surface-hover", "px-2", "py-0.5", "text-xs", "text-text-secondary"],
      },
    ]);
  });

  it("detecta la pastilla con relleno CALCULADO (`rounded-full` solo, sin `bg-`)", () => {
    // El caso del antiguo `statusPill`: el color venía de `${tone}` y el
    // literal no lo nombraba. Sin la firma `pill-radius` esto pasaría de largo.
    expect(pillFindings('className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}')).toEqual([
      { reasons: ["pill-radius"], classes: ["rounded-full", "px-2", "py-0.5", "text-xs", "font-semibold", "tone"] },
    ]);
  });

  it("no cuenta un redondeo que NO es de pastilla ni un padding parecido", () => {
    const nearMisses = [
      'className="rounded-md bg-surface-hover px-2 py-1 text-sm"',
      'className="rounded-lg bg-surface px-3 text-sm"',
      'className="rounded px-20 bg-surface-hover"', // `px-20` no es `px-2`
      'className="my-px-2 rounded bg-surface-hover"', // identificador que CONTIENE el token
      'className="rounded-fullish bg-surface-hover px-2"', // `rounded-fullish` no es `rounded-full`
      'className="rounded px-2 text-text-secondary"', // sin relleno: no es pastilla
    ].join(" ");
    expect(pillFindings(nearMisses)).toEqual([]);
  });

  it("no cuenta una pastilla nombrada en un comentario", () => {
    expect(
      pillFindings("// rounded-full bg-slate-100 px-2 py-0.5\n/* rounded bg-surface-hover px-2 */"),
    ).toEqual([]);
  });

  it("cuenta `<Badge` y no un identificador que solo lo contiene", () => {
    expect(badgeTags("const a = <Badge variant=\"success\" />; const b = <BadgeCustom />;")).toHaveLength(1);
  });

  it("distingue una variante literal de una calculada", () => {
    expect(variantSlot('<Badge variant="warning" className="mt-1">')).toBe("static:warning");
    expect(variantSlot("<Badge variant={invoiceStatusVariant(row.status)}>")).toBe(
      "dynamic:invoiceStatusVariant",
    );
    expect(variantSlot("<Badge>")).toBe("none");
  });
});

describe("adopción del Badge en las superficies de WU4", () => {
  it("el walk leyó las cuatro superficies (piso anti-vacío)", () => {
    expect(SURFACES).toHaveLength(4);
    for (const path of SURFACES) {
      const source = SOURCES.get(path);
      expect(source, `${path} existe y se pudo leer`).toBeDefined();
      expect((source ?? "").length, `${path} no está vacío`).toBeGreaterThan(MIN_SURFACE_LENGTH);
    }
  });

  it("ninguna superficie compone una pastilla a mano fuera de la lista permitida", () => {
    const offenders: string[] = [];
    for (const [path, source] of SOURCES) {
      if (ALLOWLIST.has(path)) continue;
      const findings = pillFindings(source);
      if (findings.length > 0) {
        offenders.push(
          `${path}: ${findings.map((finding) => `${finding.reasons.join("+")} [${finding.classes.join(" ")}]`).join(" | ")}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("los sitios permitidos tienen exactamente las pastillas a mano declaradas", () => {
    const failures: string[] = [];
    for (const [path, { hits: expected, reason }] of ALLOWLIST) {
      expect(reason.length, `${path} declara una razón`).toBeGreaterThan(40);
      const source = SOURCES.get(path);
      if (source === undefined) {
        failures.push(`${path}: permitido pero no existe (entrada muerta)`);
        continue;
      }
      const found = pillFindings(source).length;
      if (found !== expected) {
        failures.push(`${path}: se esperaban ${expected} pastillas a mano, hay ${found}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("cada sitio convertido usa el Badge, con la variante declarada", () => {
    const failures: string[] = [];
    for (const { path, badges, variants } of CONVERTED) {
      const source = SOURCES.get(path);
      if (source === undefined) {
        failures.push(`${path}: no está en el walk`);
        continue;
      }
      const tags = badgeTags(source);
      if (tags.length !== badges) {
        failures.push(`${path}: se esperaban ${badges} <Badge, hay ${tags.length}`);
      }
      const found = new Map<string, number>();
      for (const tag of tags) {
        const slot = variantSlot(tag);
        found.set(slot, (found.get(slot) ?? 0) + 1);
      }
      const expectedSlots = [...variants.keys()].sort();
      const foundSlots = [...found.keys()].sort();
      if (expectedSlots.join(",") !== foundSlots.join(",")) {
        failures.push(
          `${path}: variantes ${foundSlots.join(",") || "(ninguna)"}; se esperaban ${expectedSlots.join(",")}`,
        );
        continue;
      }
      for (const [slot, count] of variants) {
        if (found.get(slot) !== count) {
          failures.push(`${path}: ${slot} × ${found.get(slot) ?? 0}, se esperaban ${count}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("las superficies convertidas importan `Badge` del primitivo", () => {
    const failures: string[] = [];
    for (const { path } of CONVERTED) {
      const specifiers = badgeImportSpecifiers(SOURCES.get(path) ?? "");
      if (!specifiers.includes("Badge")) {
        failures.push(`${path}: no importa \`Badge\` (especificadores: ${specifiers.join(", ") || "ninguno"})`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("el nav NO adopta el Badge: el contador sólido se dejó a propósito", () => {
    expect(badgeTags(SOURCES.get("src/shared/components/main-nav.tsx") ?? "")).toEqual([]);
  });

  it("los helpers de pastilla viejos ya no se declaran en ninguna superficie", () => {
    for (const path of SURFACES) {
      for (const identifier of REMOVED_HELPERS) {
        expect(
          hasWholeIdentifier(stripComments(SOURCES.get(path) ?? ""), identifier),
          `${path} declara/usa \`${identifier}\``,
        ).toBe(false);
      }
    }
  });

  it("el mapeo de estado de factura existe y cubre los tres estados", () => {
    const source = stripComments(SOURCES.get("app/invoices/invoices-client.tsx") ?? "");
    const body = source.match(/function invoiceStatusVariant\b[\s\S]*?\n\}/);
    expect(body, "`invoiceStatusVariant` está declarada").not.toBeNull();
    const text = body?.[0] ?? "";
    for (const variant of ['"success"', '"destructive"', '"default"']) {
      expect(text.includes(variant), `el mapeo devuelve ${variant}`).toBe(true);
    }
    for (const status of ['"Pagada"', '"Anulada"']) {
      expect(text.includes(status), `el mapeo conoce el estado ${status}`).toBe(true);
    }
  });
});
