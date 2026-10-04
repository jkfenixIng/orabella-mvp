import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { config } from "../middleware";

/* --------------------------------------------------------------------------
   U1 (D1) — la puerta gruesa NO debe interceptar los activos estáticos.

   El logo del login (`/orabella-logo.png`) y el favicon de la app (`/icon.png`)
   son archivos de `public/` y de `app/`. Sin cookie —o sea, EN `/login`, que es
   justo donde se muestran— la Matcher losía y la respuesta era una
   redirección: el `<img>` recibía el HTML del login en lugar del PNG.

   Next evalúa la Matcher ANTES de ejecutar la función, así que la exclusión
   vive ahí y sólo ahí: `PUBLIC_PATHS` sigue siendo la lista de rutas DE
   APLICACIÓN públicas (/login, /api/v1/health, /api/v1/auth/*).

   El test compila la Matcher exportada como expresión regular —la misma
   gramática que usa Next— y exige las DOS mitades del contrato: los activos no
   caen en la puerta, y las rutas reales SIGUEN protegidas.
   --------------------------------------------------------------------------

   La gramática de la Matcher: Next la compila tal cual sobre el pathname, así
   que `^` + matcher + `$` reproduce exactamente la pregunta "¿esta ruta entra
   en la puerta?".
   */
const matcherRegex = (matcher: string): RegExp => new RegExp(`^${matcher}$`);

const matcher = config.matcher[0];

const ACTIVOS = ["/orabella-logo.png", "/icon.png", "/apple-icon.png"];

// Activos anidados: hoy no hay ninguno (public/ sólo tiene el logo en la raíz),
// pero la exclusión tiene que ser por FORMA —último segmento con punto— y no por
// posición, o el día que alguien meta `public/images/…` el logo vuelve a caer en
// la puerta sin cookie.
const ACTIVOS_ANIDADOS = [
  "/images/logo.png",
  "/sub/dir/pic.webp",
  "/assets/img/icons/hero.svg",
];

// Un punto en el NOMBRE DEL DIRECTORIO no es una extensión: la ruta sigue
// siendo de aplicación y tiene que seguir entrando en la puerta.
const RUTAS_CON_DIRECTORIO_PUNTEADO = ["/v1.2/payroll", "/legacy.v1/export"];

const RUTAS_DE_APLICACION = [
  "/payroll",
  "/invoices",
  "/admin",
  "/plataforma",
  "/api/v1/payroll-periods",
  "/login",
  "/api/v1/health",
  "/api/v1/auth/session",
];

describe("middleware: la matcher excluye los activos estáticos", () => {
  it("un activo de public/ NO entra en la puerta (sin cookie, no hay redirección)", () => {
    const regex = matcherRegex(matcher);
    for (const activo of ACTIVOS) {
      expect(regex.test(activo), `activo: ${activo}`).toBe(false);
    }
  });

  it("las rutas reales SIGUEN entrando en la puerta", () => {
    const regex = matcherRegex(matcher);
    for (const ruta of RUTAS_DE_APLICACION) {
      expect(regex.test(ruta), `ruta: ${ruta}`).toBe(true);
    }
  });

  it("CONTROL NEGATIVO: el matcher VIEJO sí interceptaba el activo", () => {
    // Si el texto viejo tampoco fallara la primera prueba, las aserciones de
    // arriba serían un sello de goma: el matcher anterior (sin exclusión de
    // extensiones) tiene que seguir capturando los activos, y eso es
    // exactamente lo que el fix borra.
    const viejo = matcherRegex("/((?!_next/static|_next/image|favicon.ico).*)");
    for (const activo of ACTIVOS) {
      expect(viejo.test(activo), `activo: ${activo}`).toBe(true);
    }
    // Y el viejo tampoco excluía nada: sólo lo que hoy se excluye.
    expect(viejo.test("/_next/static/chunk")).toBe(false);
    expect(matcher, "la matcher exportada cambió de forma").not.toBe(
      "/((?!_next/static|_next/image|favicon.ico).*)",
    );
  });

  it("un activo en un SUBDIRECTORIO NO entra en la puerta, a cualquier profundidad", () => {
    // La Matcher vigente no dice "el primer segmento tiene un punto": dice
    // "el ÚLTIMO segmento tiene un punto". Un archivo tiene su extensión al
    // final del pathname; un directorio punctuated no la tiene nunca, porque
    // después del punto viene una barra.
    const regex = matcherRegex(matcher);
    for (const activo of ACTIVOS_ANIDADOS) {
      expect(regex.test(activo), `activo anidado: ${activo}`).toBe(false);
    }
  });

  it("un punto en el NOMBRE DEL DIRECTORIO NO abre la puerta", () => {
    // `/v1.2/payroll` es una ruta de aplicación (dotted directory), no un
    // activo: el punto va seguido de `/`, así que el criterio de "último
    // segmento con punto" no la alcanza y la puerta sigue protecting.
    const regex = matcherRegex(matcher);
    for (const ruta of RUTAS_CON_DIRECTORIO_PUNTEADO) {
      expect(ruta.includes("/"), `prefijo con punto: ${ruta}`).toBe(true);
      expect(regex.test(ruta), `ruta desprotegida: ${ruta}`).toBe(true);
    }
  });

  it("DECISIÓN: `/payroll/anything.png` NO entra en la puerta (criterio de forma, no de ruta)", () => {
    // Esta ruta NO existe hoy. El criterio es de FORMA, no de rutas conocidas:
    // lo que decide es si el ÚLTIMO segmento parece un archivo. `/payroll/
    // anything.png` termina en un segmento con punto, así que la Matcher la
    // deja pasar y la función NO se ejecuta para ella.
    //
    // Consecuencia asumida a propósito: si algún día existiera una RUTA DE
    // APLICACIÓN bajo un directorio cuyo último segmento leada con un punto,
    // quedaría sin la puerta gruesa. Se acepta porque hoy la invariante del
    // proyecto es que las rutas de aplicación no llevan punto
    // (ver "la exclusión de extensiones no puede abrir una ruta de aplicación"),
    // y porque abrir `/payroll/…png` por URL es el mismo modo de fallo que el
    // que arregla este matcher: servir el archivo en vez de la aplicación.
    const regex = matcherRegex(matcher);
    expect(regex.test("/payroll/anything.png")).toBe(false);
  });

  it("CONTROL NEGATIVO: el matcher ANTERIOR (punto en el PRIMER segmento) sí interceptaba el activo anidado", () => {
    // Sin esta prueba, las de arriba serían un sello de goma: el matcher que
    // acaba de sustituir a éste anclaba el punto justo después de la barra
    // inicial, así que SÓLO alcanzaba a los archivos de la raíz.
    const anterior = matcherRegex("/((?!_next/static|_next/image|favicon.ico|[^/]*\\.[^/]*).*)");
    expect(anterior.test("/orabella-logo.png")).toBe(false);
    expect(anterior.test("/images/logo.png"), "el anterior NO excluía subdirectorios").toBe(true);
    expect(anterior.test("/sub/dir/pic.webp")).toBe(true);
    // Y el actual sí, en las tres profundidades.
    const regex = matcherRegex(matcher);
    for (const activo of ACTIVOS_ANIDADOS) {
      expect(regex.test(activo), `activo anidado: ${activo}`).toBe(false);
    }
  });

  it("la exclusión de extensiones no puede abrir una ruta de aplicación", () => {
    // La Matcher es una lista negativa dentro de un mismo pathname. El criterio
    // vigente es "el ÚLTIMO segmento tiene un punto" (un archivo), no "algún
    // segmento tiene un punto": una ruta de aplicación sólo se confundiría con
    // un archivo si su último segmento leyera con punto, y ninguna lo lleva.
    // Esta prueba lo deja dicho, no lo supone.
    const rutas = [
      "/payroll",
      "/invoices",
      "/admin",
      "/plataforma",
      "/cash",
      "/services",
      "/vales",
      "/alerts",
      "/inventory",
      "/login",
      "/api/v1/health",
      "/api/v1/auth/session",
      "/api/v1/payroll-periods",
    ];
    for (const ruta of rutas) {
      expect(ruta.includes("."), `ruta con punto: ${ruta}`).toBe(false);
    }
    // Y el matcher vigente captura las trece: ninguna quedó desprotegida.
    const regex = matcherRegex(matcher);
    for (const ruta of rutas) {
      expect(regex.test(ruta), `ruta desprotegida: ${ruta}`).toBe(true);
    }
  });

  it("la exclusión se hizo en la matcher, NO en PUBLIC_PATHS", () => {
    const fuente = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");
    const declaracion = fuente.slice(
      fuente.indexOf("const PUBLIC_PATHS"),
      fuente.indexOf("];", fuente.indexOf("const PUBLIC_PATHS")),
    );
    // La lista de rutas DE APLICACIÓN públicas queda exactamente como estaba:
    // ni una ruta más, ni una menos.
    expect(declaracion).toContain("/^\\/login\\/?$/");
    expect(declaracion).toContain("/^\\/api\\/v1\\/health\\/?$/");
    expect(declaracion).toContain("/^\\/api\\/v1\\/auth(\\/|$)/");
    expect(declaracion.match(/\/\^/g)).toHaveLength(3);
    // Y la matcher es una sola expresión.
    expect(config.matcher).toHaveLength(1);
  });
});
