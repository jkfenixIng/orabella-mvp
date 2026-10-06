import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
// El MISMO módulo del que `src/components/ui/lib/utils.ts` importa el `twMerge`
// que usa `cn(...)`. No es una copia de la regla de fusión: es la regla.
import { twMerge } from "tailwind-merge";

/* --------------------------------------------------------------------------
   R2, R32 y R7 — las tres primitivas que la auditoría de responsive midió como
   bloqueantes, y que pagan en TODAS las pantallas.

   Ninguna es una pantalla: las tres son `main-nav.tsx` (el cajón móvil),
   `form-dialog.tsx` (el pie de los formularios) y `dialog.tsx` (la caja del
   diálogo). Por eso van juntas: se corrigen una vez y el arreglo se paga en
   todas partes.

   Método: no hay DOM en este setup (`environment: "node"`). Lo que se afirma es
   de dos clases, igual que `ux-dialog.test.ts`:

     1. lo que se puede ejecutar — que los módulos importen y exporten lo que
        prometían (el `Dialog` de Radix, `FormDialog`/`ConfirmDialog`);
     2. lo que solo se puede leer del fuente — el marcado y el vocabulario de
        clases, con el archivo real leído por `node:fs`.

   LO QUE UNA GUARDA DE FUENTE NO PUEDE PROBAR, DICHO DE ANTEMANO: el focus trap
   de Radix, la tecla Escape y el bloqueo de scroll. Un `readFileSync` no abre
   un navegador. Lo que sí afirma R2 acá es la CAUSA medible en el fuente —que el
   cajón no sea un `role="dialog"` escrito a mano sino la primitiva— y el
   comportamiento se verificó aparte en Chromium real (ver `odd/tasks/
   auditoria-responsive.md` y el informe de la unidad). Una guarda de fuente
   que fingiera medir el foco sería un sello de goma.

   TOKENS COMPLETOS, NUNCA SUBSTRINGS: este repositorio se quemó dos veces con
   greps de substring (`text-text-primary` TERMINA en `text-primary`;
   `border-border` MATCHEA `border-border-color`). Todo se compara como token de
   clase entero, con la variante incluida. Los controles negativos al final
   HACEN que un predicado roto falle en vez de pasar solo.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();
const NAV_PATH = join(APP_ROOT, "src", "shared", "components", "main-nav.tsx");
const DIALOG_PATH = join(APP_ROOT, "src", "components", "ui", "lib", "dialog.tsx");
const FORM_DIALOG_PATH = join(APP_ROOT, "src", "components", "ui", "lib", "form-dialog.tsx");

const NAV = readFileSync(NAV_PATH, "utf8");
const DIALOG = readFileSync(DIALOG_PATH, "utf8");
const FORM_DIALOG = readFileSync(FORM_DIALOG_PATH, "utf8");
const INVOICES = readFileSync(
  join(APP_ROOT, "app", "invoices", "invoices-client.tsx"),
  "utf8",
);

/** Código sin comentarios: una clase o un rol narrado al EXPLICAR no está aplicado. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const NAV_CODE = stripComments(NAV);
const DIALOG_CODE = stripComments(DIALOG);
const FORM_DIALOG_CODE = stripComments(FORM_DIALOG);

/**
 * Tokens de clase de un fragmento: cada uno con su variante, cortados enteros.
 * `w-full` no matchea `w-full-ish`, `sm:w-full` no matchea `w-full`.
 */
function classTokens(source: string): string[] {
  return stripComments(source).match(/[A-Za-z0-9_:./%()[\]!-]+/g) ?? [];
}

/** ¿el fragmento declara EXACTAMENTE este token de clase, con o sin variante? */
function hasClassToken(source: string, token: string): boolean {
  return classTokens(source).includes(token);
}

/**
 * Bloque de un elemento JSX: desde `<tag` hasta el primer `>` que lo cierra.
 *
 * Es un corte léxico y no un parser, y por eso solo es honesto en superficies
 * donde el `className` no contiene `>`: los tres archivos de esta guarda
 * cumplen eso (incluso `w-[calc(100%-2rem)]`, que es lo más raro que pasa por
 * acá y no lleva `>`).
 */
function jsxBlock(source: string, tag: string, occurrence = 0): string {
  const clean = stripComments(source);
  let index = -1;
  for (let seen = 0; seen <= occurrence; seen += 1) {
    index = clean.indexOf(`<${tag}`, index + 1);
    if (index < 0) {
      throw new Error(`el fuente no declara la ocurrencia ${occurrence} de \`<${tag}\``);
    }
  }
  const end = clean.indexOf(">", index);
  if (end < 0) throw new Error(`\`<${tag}\` en ${index} no cierra`);
  return clean.slice(index, end + 1);
}

/**
 * Una declaración `const` completa del fuente, sin sus comentarios.
 *
 * Va del `const X =` hasta su `X.displayName`: es la unidad de código que este
 * archivo afirma, no el archivo entero. Afirmar sobre el archivo entero haría
 * que cualquier `aria-label` escrito en otra parte del módulo doblegara la
 * guardia de `DialogContent`.
 */
function constDeclaration(source: string, name: string): string {
  const clean = stripComments(source);
  const start = clean.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`el fuente no declara \`const ${name} =\``);
  const displayName = clean.indexOf(`${name}.displayName`, start);
  const end = displayName < 0 ? clean.length : displayName;
  return clean.slice(start, end);
}

/**
 * El elemento PELADO con el que un componente de anuncio (`DialogTitle`,
 * `DialogDescription`) se hace pasar por el primitivo de Radix.
 *
 * Devuelve `""` cuando el componente renderiza `DialogPrimitive.Title` /
 * `DialogPrimitive.Description`, que es lo que arman el `titleId` /
 * `descriptionId` y, con ellos, el `aria-labelledby` / `aria-describedby` que
 * Radix pone en el contenido. Si devuelve texto, ese texto ES el elemento
 * culpable y la guardia falla nombrándolo.
 *
 * Por qué no alcanza con buscar la cadena: el nav siempre tuvo
 * `<DialogTitle>Menú principal</DialogTitle>` y el diálogo se seguía anunciando
 * `name=""` con el texto a la vista adentro. La cadena estaba; el MECANISMO no.
 * Un `<h2>` y un `<p>` son los dos cuerpos del defecto, así que el predicado
 * acusa cualquier ETIQUETA HTML en minúscula de la declaración: en TypeScript un
 * argumento de genérico es un identificador en mayúscula (`React.ElementRef<…>`,
 * `React.HTMLAttributes<…>`), así que el filtro no depende de cómo estén
 * partidos los renglones del `forwardRef`.
 */
function dialogAnnouncementBlock(source: string, component: string): string {
  const declaration = constDeclaration(source, component);
  const radix = component === "DialogTitle" ? "Title" : "Description";
  if (new RegExp(`<DialogPrimitive\\.${radix}\\b`).test(declaration)) return "";
  // Etiqueta HTML en minúscula: JSX, nunca un tipo. El defecto medido es
  // exactamente esto —el `<h2>` del título y el `<p>` de la descripción— y
  // cualquier otro nombre accesible escrito a mano cae en el mismo predicado.
  const bare = declaration.match(/<(h[1-6]|p|span|div|label|strong|legend|dt|dd)\b/);
  if (!bare) {
    // Ni el mecanismo ni un culpable identificable: no se puede affirmar nada,
    // y una guardia que pasa sin poder decidir es un sello de goma.
    throw new Error(
      `\`${component}\` no renderiza ni \`DialogPrimitive.${radix}\` ni un elemento pelado: no se puede afirmar el mecanismo`,
    );
  }
  return bare[0];
}

/**
 * La clase BASE que `cn(...)` le pasa a un elemento: el primer literal de
 * cadena del `className={cn(...)}`. Es lo que el primitivo impone; lo que
 * llega por prop `className` se fusiona después con `tailwind-merge` y no
 * cuenta como parte del contrato de la primitiva.
 */
function cnBaseClass(source: string, tag: string, occurrence = 0): string {
  const block = jsxBlock(source, tag, occurrence);
  const start = block.indexOf("cn(");
  if (start < 0) throw new Error(`\`<${tag}\` no usa \`cn(\``);
  const literal = block.slice(start).match(/'([^']*)'/);
  if (!literal) throw new Error(`\`<${tag}>\` no tiene un literal de clase en \`cn(\``);
  return literal[1];
}

/* ==========================================================================
   LA CLASE EFECTIVA.

   Una guarda de fuente que solo busca un TOKEN no puede ver una regresión de
   fusión, y esta es la prueba. La base de `DialogContent` pasó de `p-6` a
   `p-4 sm:p-6`, los seis diálogos de hoja completa de facturación siguen
   pasando `p-0`, y `tailwind-merge` NO considera que `p-0` derrote a `sm:p-6`:
   son el MISMO grupo con distinta VARIANTE, así que la de `sm:` sobrevive. El
   token `p-0` estaba — y la guarda que solo miraba el token `p-0` quedó verde —
   mientras el navegador pintaba un marco oscuro de 24 px alrededor de la hoja en
   los seis diálogos, a 1024 y a 1440 (medido en Chromium).

   Lo que sigue mezcla la base REAL de la primitiva con la clase REAL de cada
   llamador, con el mismo `twMerge`. Si mañana la primitiva cambia, estas
   guardas no se enteran de nada.
   ========================================================================== */

/** El `className="..."` de CADA `<DialogContent>` del archivo, en orden de fuente. */
function dialogContentClassNames(source: string): (string | null)[] {
  return stripComments(source)
    .split("<DialogContent")
    .slice(1)
    .map((segment) => segment.match(/className="([^"]*)"/)?.[1] ?? null);
}

/** Los diálogos de HOJA COMPLETA: los que piden `p-0` y traen su propio papel. */
function fullBleedClassNames(source: string): string[] {
  return dialogContentClassNames(source).filter(
    (value): value is string => value !== null && /\bp-0\b/.test(value),
  );
}

/** La clase EFECTIVA de un diálogo: exactamente lo que `cn()` le pasa a Radix. */
function effectiveContentClass(base: string, caller: string): string[] {
  return twMerge(base, caller).split(/\s+/).filter(Boolean);
}

/**
 * Variantes de padding que SOBREVIVEN a la fusión y no son el opt-out de
 * sangrar a sangre.
 *
 * `sm:p-0` NO es un defecto: es la mitad derecha declarada de «esta hoja no
 * tiene padding». Lo que no puede sobrevivir es `sm:p-6` (o cualquier otro
 * `sm:p-*` que la primitiva impone), porque a 640 px y más gana por orden de
 * fuente y devuelve el marco.
 */
function survivingPaddingVariants(base: string, caller: string): string[] {
  return twMerge(base, caller)
    .split(/\s+/)
    .filter((token) => /^(sm|md|lg|xl|2xl):p/.test(token) && token !== "sm:p-0");
}

/* ==========================================================================
   R2 — el cajón móvil tiene que ser MODAL de verdad.

   MEDIDO (Chromium real, 320x568 / 360 / 390): con el menú abierto, Escape NO
   lo cerraba (`escapeClosed=false` en los tres anchos), el duodécimo Tab
   aterrizaba en un input DETRÁS del velo, el fondo seguía scrolleando
   (`scrollTo(0,400)` → `scrollY=400` desde 0) y al cerrar el foco quedaba en
   `BODY` en vez de volver al botón.

   La causa es una sola línea de fondo: el panel se escribía a mano con
   `role="dialog" aria-modal="true"`, y ESOS ATRIBUTOS SON UNA DECLARACIÓN, NO
   UN COMPORTAMIENTO. `aria-modal="true"` le PROMETE al lector de pantalla que lo
   de atrás está muerto, y no lo está: por eso el foco se escapa al fondo y por
   eso Escape no hace nada. El arreglo no es «agregar el handler que falta»: es
   dejar de fingir y usar la primitiva que ya trae trampa de foco, Escape, lock
   de scroll y el apilado de z-index que usa el resto de los diálogos.
   ========================================================================== */

/**
 * El cajón escrito a mano: un `role="dialog"` declarado en el JSX. Es el patrón
 * que la guarda tiene que ACUSAR, no el que tiene que perdurar.
 */
function handRolledDrawer(source: string): string[] {
  const clean = stripComments(source);
  const offenders: string[] = [];
  for (const segment of clean.split("<div").slice(1)) {
    const block = segment.slice(0, segment.indexOf(">") + 1);
    if (/\brole="dialog"/.test(block)) offenders.push('role="dialog" escrito a mano');
    if (/\baria-modal="true"/.test(block)) offenders.push('aria-modal="true" escrito a mano');
  }
  return offenders;
}

describe("R2: el cajón móvil es la primitiva `Dialog`, no un `aria-modal` de mentira", () => {
  it("no queda ningún `role=\"dialog\"` ni `aria-modal` escritos a mano", () => {
    expect(handRolledDrawer(NAV)).toEqual([]);
  });

  it("el nav importa la primitiva del cajón del repo, no la de Radix directo", () => {
    const importBlock = NAV_CODE.match(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*ui\/lib\/dialog["']/);
    expect(importBlock, "main-nav.tsx importa desde `ui/lib/dialog`").not.toBeNull();
    const specifiers = (importBlock?.[1] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    for (const required of ["Dialog", "DialogContent", "DialogTitle"]) {
      expect(specifiers, `importa \`${required}\``).toContain(required);
    }
    // La primitiva del cajón es la del repo: si el nav importara
    // `@radix-ui/react-dialog` directamente, se saltaría el apilado de z-index
    // (`computeDialogZIndex`) que comparte con Select y Combobox.
    expect(NAV_CODE).not.toContain("@radix-ui/react-dialog");
  });

  it("el panel del cajón lo renderiza `<DialogContent>` y sigue siendo el de siempre", () => {
    // El cajón sigue siendo el panel izquierdo del ancho que tenía, no una caja
    // centrada: R27 lo midió en 288 px y esa geometría NO es el defecto.
    expect(NAV_CODE).toContain("<DialogContent");
    expect(hasClassToken(jsxBlock(NAV_CODE, "DialogContent"), "w-72")).toBe(true);
    expect(hasClassToken(jsxBlock(NAV_CODE, "DialogContent"), "left-0")).toBe(true);
  });

  it("el nombre del cajón lo da el MECANISMO de la primitiva, no el `<DialogTitle>` del nav", () => {
    // Lo primero no alcanza, y por eso no es lo que se afirma: el nav siempre
    // tuvo la cadena `<DialogTitle`, y el panel se seguía anunciando mudo
    // (`name=""`, `aria-labelledby=null`, `aria-label=null`, con el `<h2>` de
    // «Menú principal» presente y visible adentro). Una guarda que solo mira la
    // cadena no puede ver ese defecto: la cadena estaba y el nombre no.
    expect(NAV_CODE).toContain("<DialogTitle");
    expect(NAV_CODE).not.toMatch(/aria-label="Menú principal"/);

    // Lo que se afirma es el mecanismo: el título del cajón tiene que ser el
    // TÍTULO DE RADIX, para que exista el `titleId` y el `aria-labelledby` que
    // arman el nombre accesible.
    expect(dialogAnnouncementBlock(DIALOG_CODE, "DialogTitle")).toBe("");
  });

  it("el botón de la barra abre el cajón por la primitiva, y el velo ya no es suyo", () => {
    // Con `DialogTrigger` el foco vuelve al botón al cerrar sin código de foco
    // escrito a mano, y el velo pasa a ser el de `DialogContent`.
    expect(NAV_CODE).toContain("<DialogTrigger");
    expect(NAV_CODE).toContain("asChild");
    expect(NAV_CODE).not.toContain("bg-black/40");
    // El id que la barra declara en `aria-controls` sigue existiendo: el
    // contrato entre el botón y el panel no se pierde en el cambio.
    expect(NAV_CODE).toContain('aria-controls="menu-movil"');
    expect(NAV_CODE).toContain('id="menu-movil"');
  });
});

/* ==========================================================================
   R-B — el alcance del nombre accesible es TODO el app, y el arreglo es de la
   primitiva.

   MEDIDO antes del arreglo (Chromium, nombre accesible calculado por el motor):
   `""` en los siete diálogos abiertos — el cajón, facturación (facturar,
   detalle, editar, agregar ítem), «Nuevo empleado» (que es un `FormDialog`, o sea
   otra ruta de código: `form-dialog.tsx`) y «Solicitar vale». Siete de siete, con
   el `<h2>` correcto a la vista en todos.

   `DialogDescription` tenía el MISMO defecto latente: un `<p>` pelado, así que
   nunca se emitía el `descriptionId` y el `aria-describedby` tampoco se armaba.
   La forma de reproducirlo sin abrir siete pantallas es la misma: el defecto es
   de la PRIMITIVA, y la primitiva es una sola línea por componente.

   CRITERIO: «el `DialogTitle`/`DialogDescription` de `dialog.tsx` ES el de
   Radix». Se eligió el mecanismo y no un `aria-label` en cada `DialogContent`
   porque el defecto medido es de la primitiva (siete de siete, y el `<h2>`
   presente), y porque con el mecanismo no hay 29 llamados que puedan olvidarse:
   hoy hay 27 `<DialogTitle>` puestos en 11 archivos y el nombre era `""` en todos.
   ========================================================================== */

describe("R-B: el nombre y la descripción accesibles salen del mecanismo de la primitiva", () => {
  it("`DialogTitle` es `DialogPrimitive.Title`, no un `<h2>` pelado", () => {
    // Falla contra el estado previo (`<h2 …>` sin `id`): es exactamente lo que
    // midió `name=""` con `aria-labelledby=null` en los siete diálogos.
    expect(dialogAnnouncementBlock(DIALOG_CODE, "DialogTitle")).toBe("");
  });

  it("`DialogDescription` es `DialogPrimitive.Description`, no un `<p>` pelado", () => {
    // El mismo defecto latente del título, un peldaño más abajo: sin
    // `descriptionId` el contenido del diálogo no lleva `aria-describedby`.
    expect(dialogAnnouncementBlock(DIALOG_CODE, "DialogDescription")).toBe("");
  });

  it("la primitiva no se escapa por un atributo escrito a mano", () => {
    // El otro camino posible para el nombre —un `aria-label` en el
    // `DialogContent`— no existe, y no debe aparecer por la puerta de atrás:
    // dejaría el nombre en el llamador, que es el defecto de nuevo. Otra vez:
    // 29 diálogos, 29 oportunidades de olvidarse.
    //
    // R-C acota el alcance a la ETIQUETA DE APERTURA del contenido, que es
    // donde viviría ese nombre. El `aria-label="Cerrar"` que R-C monta adentro
    // es de otro control —el botón de cierre— y no nombra al diálogo: el nombre
    // del diálogo lo sigue dando el mecanismo del título, y eso lo afirman las
    // dos pruebas de arriba, que no se tocaron.
    const content = constDeclaration(DIALOG_CODE, "DialogContent");
    const apertura = content.match(/<DialogPrimitive\.Content\b[\s\S]*?\n\s*>/)?.[0] ?? "";
    expect(apertura.length, "la etiqueta de apertura del contenido").toBeGreaterThan(0);
    expect(apertura).not.toMatch(/\baria-label=/);
    expect(apertura).not.toMatch(/\baria-labelledby=/);
    // Y que el atajo siga siendo UNO solo: si mañana aparece un segundo
    // `aria-label` a mano en la declaración, es otro control nombrado por
    // atributo y hay que mirarlo.
    expect(content.match(/\baria-label=/g) ?? [], "un solo atributo a mano").toHaveLength(1);
  });
});

/* ==========================================================================
   R32 — el pie de los formularios tiene que estar PEGADO abajo.

   MEDIDO: en «Nuevo empleado» a 320 el contenido del diálogo mide 1527 px
   contra 534 px de caja, y los botones quedan en `y≈1438-1520` contra un
   viewport de 568. O sea que hay que scrollear DENTRO del diálogo para poder
   guardar. Lo mismo en «Emitir factura» (1005 px) y «Crear producto» (819 px).
   «Registrar movimiento» entra y no falla: el fallo es del que se pasa de alto.
   ========================================================================== */

describe("R32: la fila de acciones de `FormDialog` está pegada al borde de abajo", () => {
  /**
   * La fila de acciones del formulario. Vive en una constante nombrada —es una
   * regla de disposición, no una clase suelta— y la guarda lee ESA constante y
   * además que el pie la use, para que el contrato no dependa del markup.
   */
  function formActionRowClass(): string {
    const declared = FORM_DIALOG_CODE.match(
      /const STICKY_ACTION_ROW_CLASS\s*=\s*\n?\s*"([^"]*)"/,
    );
    if (!declared) throw new Error("el fuente no declara `STICKY_ACTION_ROW_CLASS`");
    // Y que el pie la monte de verdad, no que la constante exista y no se use.
    expect(jsxBlock(FORM_DIALOG_CODE, "DialogFooter")).toContain("STICKY_ACTION_ROW_CLASS");
    return declared[1];
  }

  it("la acción primaria y Cancelar están pegadas al borde inferior del scroll", () => {
    const actionRow = formActionRowClass();
    // `sticky` + `bottom-0` es lo que la deja siempre alcanzable sin scroll
    // interno: el pie sigue al final del flujo (no tapa ningún campo) pero se
    // ancla al borde de abajo mientras el contenido scrollea debajo.
    expect(hasClassToken(actionRow, "sticky")).toBe(true);
    expect(hasClassToken(actionRow, "bottom-0")).toBe(true);
  });

  it("la barra es opaca y separada: el contenido que pasa por detrás no se lee encima", () => {
    const actionRow = formActionRowClass();
    expect(hasClassToken(actionRow, "bg-surface")).toBe(true);
    expect(hasClassToken(actionRow, "border-t")).toBe(true);
  });

  it("llega al borde del diálogo: el padding de abajo vive en el contenedor, no en la barra", () => {
    // `sticky bottom: 0` ancla contra la CAJA DE CONTENIDO del contenedor de
    // scroll, o sea por encima de su `padding-bottom`. Con `p-4` la barra
    // terminaba 16 px antes del borde y por debajo de ella seguía pasando
    // contenido scrolleado. La solución no es un margen negativo más grande
    // (medido: `-mb-8` no mueve la barra), es que el contenedor no tenga padding
    // abajo.
    expect(jsxBlock(FORM_DIALOG_CODE, "DialogContent")).toContain("FORM_DIALOG_CONTENT_CLASS");
    expect(FORM_DIALOG_CODE).toContain('const FORM_DIALOG_CONTENT_CLASS = "pb-0"');

    const actionRow = formActionRowClass();
    // Sin margen inferior negativo: no hay padding que cancelar abajo y un
    // `-mb-*` ahí solo levantaría la barra del borde.
    expect(hasClassToken(actionRow, "-mb-4")).toBe(false);
    expect(hasClassToken(actionRow, "sm:-mb-6")).toBe(false);
    // Y con el `-mx-*` la barra se sangra a los lados, así que el padding se
    // devuelve: sin esto los botones quedarían pegados al borde del diálogo.
    expect(hasClassToken(actionRow, "-mx-4")).toBe(true);
    expect(hasClassToken(actionRow, "px-4")).toBe(true);
    expect(hasClassToken(actionRow, "sm:-mx-6")).toBe(true);
    expect(hasClassToken(actionRow, "sm:px-6")).toBe(true);
  });

  it("sigue siendo la ÚLTIMA pieza del `<form>`: en el flujo no cubre el último campo", () => {
    const formBlock = FORM_DIALOG_CODE.slice(
      FORM_DIALOG_CODE.indexOf("<form onSubmit="),
      FORM_DIALOG_CODE.indexOf("</form>"),
    );
    const lastTag = formBlock.lastIndexOf("</DialogFooter>");
    expect(lastTag, "el `<form>` declara el pie de acciones").toBeGreaterThan(-1);
    // Nada se renderiza después del pie dentro del formulario: si mañana se
    // agrega un campo abajo del pie, la barra lo taparía y esta guarda lo
    // detecta.
    expect(formBlock.slice(lastTag + "</DialogFooter>".length).trim()).toBe("");
  });

  it("el ancho de la barra sigue el del diálogo: `p-4` debajo de `sm` y `p-6` arriba", () => {
    // Si `dialog.tsx` bajara a `p-5` sin que esto cambie, la barra dejaría de
    // llegar al borde. Los dosPadding viven en archivos distintos y esta es la
    // única cuenta que los ata.
    const dialogPadding = classTokens(cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content"));
    expect(dialogPadding).toContain("p-4");
    expect(dialogPadding).toContain("sm:p-6");
  });
});

/* ==========================================================================
   R7 — el diálogo no puede tocar los bordes de la pantalla.

   MEDIDO: a 320/360/390 el rect del diálogo es `left=0, right=ancho del
   viewport` — gutter 0 en los dos lados — y la caja de contenido mide
   `ancho−48`, o sea 272 px a 320. A 1024 el diálogo de emisión (`p-0`,
   `max-w-5xl`) también mide 1024 con gutter 0. Un borde pegado al borde es
   la razón por la que un `shadow` no se ve y por la que el diálogo se lee
   como la página.
   ========================================================================== */

describe("R7: el diálogoRespira debajo de `sm` y usa la altura dinámica", () => {
  it("deja gutter a los dos lados por debajo de `sm`, con UN solo reclamo de ancho", () => {
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    // 1 rem de gutter por lado por debajo de `sm`.
    expect(hasClassToken(base, "w-[calc(100%-2rem)]")).toBe(true);
    // Lo que ESTE test afirmaba antes era `sm:w-full`, y era un criterio
    // disfrazado de un nombre de token: `sm:w-full` PISA a
    // `w-[calc(100%-2rem)]` en la cascada, así que con él el gutter NO se
    // sostenía arriba de `sm` (medido a 1024: gutter 0/0). El problema del
    // criterio no era que midiera mal: es que `md:w-full` o `2xl:w-*` lo
    // rompen igual y NADIE los miraba. Ahora se afirma la PROPIEDAD — el
    // gutter se cuenta como un único reclamo de ancho en la base, sin
    // variante, que ningún `sm:`/`md:`/`lg:` pueda pisar— y `sm:w-full` queda
    // como un caso particular de ella, no como el nombre que alguien recuerda.
    expect(
      claimsDeAnchoConVariante(base),
      "la base no reclama el ancho con variante: un `sm:w-full` (o `md:`, `2xl:`) devuelve el gutter a 0",
    ).toEqual([]);
  });

  it("el padding baja en el extremo angosto y sube en el ancho", () => {
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    expect(hasClassToken(base, "p-4")).toBe(true);
    expect(hasClassToken(base, "sm:p-6")).toBe(true);
  });

  it("el gutter se sostiene donde `max-w` alcanza el viewport (R7 a 1024)", () => {
    // El criterio, no el token, en las dos mitades: para NINGÚN diálogo, en
    // NINGÚN ancho de pantalla, (1) el ancho efectivo llega al del viewport, ni
    // (2) deja de respetar el `max-w` que le puso ESE llamador.
    //
    // La segunda mitad YA NO es un sello de goma. Antes comparaba contra
    // `max()` de `anchoToken(t, 1920)` sobre TODOS los tokens: como
    // `w-[calc(100%-2rem)]` está en esa lista y vale 1888 a 1920, `pedido` era
    // la CONSTANTE 1888 para los seis diálogos, y con el bucle topado en 1920
    // la comparación no podía fallar sola. Ahora `pedidoDelLlamador` lee las
    // clases DEL LLAMADOR: 1024 para `max-w-5xl`, 896 para `max-w-4xl`, 512
    // para `max-w-lg`, 384 para `max-w-sm`, y el número cambia con cada
    // llamada.
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    let pedidosComprobados = 0;
    for (const caller of fullBleedClassNames(INVOICES)) {
      const tokens = effectiveContentClass(base, caller);
      for (const vw of [320, 390, 640, 768, 1024, 1280, 1440, 1920]) {
        const ancho = anchoEfectivo(tokens, vw);
        expect(ancho, `\`${caller}\` a ${vw}px: gutter ≥ 1rem por lado`).toBeLessThanOrEqual(vw - 32);
        // El máximo de ESTE llamador a ESTE viewport. Si no pide ninguno, no
        // hay nada que respetar —y comparar contra el `max-w` de la base sería
        // la tautología que esta cuenta vino a matar.
        const pedido = pedidoDelLlamador(caller, vw);
        if (pedido === null) continue;
        pedidosComprobados += 1;
        expect(
          ancho,
          `\`${caller}\` a ${vw}px: no excede los ${pedido}px que pidió este llamador`,
        ).toBeLessThanOrEqual(pedido);
      }
    }
    // La cuenta no puede quedarse sin comparar nada: sin esto, un `pedido`
    // siempre `null` devolvería esta mitad en verde.
    expect(pedidosComprobados, "se comparó contra un máximo pedido al menos una vez").toBeGreaterThan(0);
  });

  it("la base NO se queda con un tope de ancho que le gane al llamador", () => {
    // El otro lado del mismo negocio, dicho como CRITERIO y no como el nombre
    // del token que existe hoy. `sm:max-w-[calc(100%-2rem)]` es el arreglo
    // «obvio» que se descartó, pero el predicado no lo nombra: `md:max-w-*`,
    // `lg:max-w-*` o `2xl:max-w-*` son el mismo defecto —el `max-width` es UNA
    // sola propiedad y el media query le gana al `max-w-5xl` sin
    // variante del llamador— y pasaban igual.
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    expect(
      topesDeLaBase(base).filter((token) => token.includes(":")),
      "la base no declara ningún `max-w-*` con variante",
    ).toEqual([]);

    // Y la mitad que no depende de leer variantes: para todo llamador que SÍ
    // pide un máximo, la fusión tiene que dejar la clase efectiva SIN ningún
    // `max-w` que venga de la base. El `max-w-lg` sin variante de la primitiva
    // (que es su ancho por defecto) sí puede estar, y en este caso NO sobrevive:
    // `tailwind-merge` lo descarta porque es el mismo grupo que el pedido del
    // llamador. Si mañana aparece un `sm:max-w-*`, sobrevive y esta falla.
    const piden = llamadoresQuePidenToppe(INVOICES);
    expect(piden, "los <DialogContent> de facturación que piden un máximo").not.toEqual([]);
    for (const caller of piden) {
      expect(
        topesDeLaBaseQuePisanAlLlamador(base, caller),
        `\`${caller}\`: ningún tope de la base sobrevive por encima del pedido del llamador`,
      ).toEqual([]);
    }
  });

  it("el ancho no excede el MÁXIMO QUE PIDIÓ ESE llamador, a ningún viewport", () => {
    // El criterio que reemplaza la comparación contra la constante 1888, con
    // los números que se midieron en Chromium: `max-w-4xl` → 896 (con 544 de
    // gutter a 1440) y `max-w-lg` → 512 (con 512 de gutter a 1024). Si la base
    // vuelve a tapar al llamador, estos dos se estiran y la comparación falla
    // con el número al lado, no con un `true` que nadie puede questionar.
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    const CASOS: { caller: string; pedido: number }[] = [
      { caller: "max-w-4xl border-0 bg-transparent p-0 sm:p-0 shadow-none", pedido: 896 },
      { caller: "max-w-lg border-0 bg-transparent p-0 sm:p-0 shadow-none", pedido: 512 },
      { caller: "max-w-5xl border-0 bg-transparent p-0 sm:p-0 shadow-none", pedido: 1024 },
      { caller: "max-w-sm border-0 bg-transparent p-0 sm:p-0 shadow-none", pedido: 384 },
    ];
    for (const { caller, pedido } of CASOS) {
      // El número del caso es el que se midió, no el que sale de la cuenta: si
      // la escala de Tailwind cambiara, esta guarda lo señala en vez de
      // recalcularse en verde.
      expect(pedidoDelLlamador(caller, 1920), `\`${caller}\` pide ${pedido}px`).toBe(pedido);
      const tokens = effectiveContentClass(base, caller);
      for (const vw of [320, 390, 640, 768, 1024, 1280, 1440, 1920, 2560]) {
        const ancho = anchoEfectivo(tokens, vw);
        expect(
          ancho,
          `\`${caller}\` a ${vw}px: ${ancho}px no pasa de los ${pedido}px pedidos`,
        ).toBeLessThanOrEqual(pedido);
        expect(ancho, `\`${caller}\` a ${vw}px: gutter ≥ 1rem por lado`).toBeLessThanOrEqual(vw - 32);
      }
    }
  });

  it("la altura usa `dvh`, no `vh`", () => {
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    expect(hasClassToken(base, "max-h-[calc(100dvh-2rem)]")).toBe(true);
    //HONESTIDAD DEL ESTADO DE ESTA AFIRMACIÓN: en Chromium headless
    //`100vh == 100dvh == innerHeight` en los cuatro anchos que midió la
    //auditoría, así que la diferencia NO es observable acá y esta guarda no la
    //mide. Lo que afirma es que el primitive NO vuelve a `vh`, que es la regla
    //del repo (`ux-structure.test.ts` y `page.tsx:56` ya usan `dvh`) y lo que
    //un navegador móvil real hace cuando aparece la barra de direcciones.
    expect(DIALOG_CODE).not.toMatch(/\b\d*vh\b/);
  });

  it("los SEIS diálogos `p-0` quedan SIN padding en la clase EFECTIVA", () => {
    // MEDIDO antes del arreglo, en Chromium, a 1024 y a 1440: los diálogos de
    // hoja completa («Emitir factura», «Ver detalle», «Editar factura», «Agregar
    // ítem»)computaban `padding: 24px` en los cuatro lados y la hoja interior
    // quedaba a 24 px del borde del diálogo — un marco oscuro alrededor del
    // papel, con la hoja midiendo 976 px dentro de una caja de 1024.
    //
    // La guarda anterior miraba el TOKEN `p-0` y por eso quedó verde con el
    // defecto vivo. Esta mira la clase EFECTIVA de los SEIS, mezclada con el
    // mismo `twMerge` que usa la primitiva.
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    const fullBleed = fullBleedClassNames(INVOICES);
    // El número importa: si mañana aparece un séptimo diálogo de hoja completa,
    // esta guarda tiene que exigirle lo mismo en vez de seguirPassed en verde
    // sobre los seis de siempre.
    expect(
      fullBleed,
      "los <DialogContent> de hoja completa (`p-0`) de facturación",
    ).toHaveLength(6);

    for (const [index, caller] of fullBleed.entries()) {
      const etiqueta = `diálogo de hoja completa ${index + 1} (\`${caller}\`)`;

      // 1. Ninguna variante de padding sobrevive a la fusión.
      expect(survivingPaddingVariants(base, caller), etiqueta).toEqual([]);

      // 2. Los dos lados del breakpoint dicen cero: abajo de `sm` y desde 640.
      const paddings = effectiveContentClass(base, caller).filter((token) =>
        /^(?:(?:sm|md|lg|xl|2xl):)?p[a-z]?-/.test(token),
      );
      expect([...paddings].sort(), `${etiqueta}: el padding en los dos lados`).toEqual([
        "p-0",
        "sm:p-0",
      ]);

      // 3. Y el ANCHO lo sigue poniendo la primitiva: un `w-*` propio en el
      //    llamador devolvería el gutter a cero (es el R7 medido a 1024).
      expect(
        classTokens(caller).filter((token) => /^(sm:|md:|lg:|xl:|2xl:)?w-/.test(token)),
        `${etiqueta}: el ancho lo pone la primitiva`,
      ).toEqual([]);
    }
  });
});

/* ==========================================================================
   R7 — el ancho efectivo, que es el CRITERIO, no el token.

   `sm:w-full` era el token que se afirmaba, y con él el R7 quedaba cerrado a
   320 y ABIERTO a 1024: `max-w-5xl` son exactamente 1024 px, así que a 1024 el
   diálogo de emisión daba `width=1024`, `left=0`, `right=1024` y gutter 0/0
   (medido en Chromium). Un token no puede ver esa interacción entre el ancho y
   el `max-w` del llamador; hace falta la CUENTA, que es lo que hace
   `anchoEfectivo` de más abajo: el ancho final es el menor entre el `w-*` y el
   `max-w-*` que estén VIGENTES a ese ancho de pantalla, y lo que hay que
   afirmar es que ese menor siempre deja gutter.
   ========================================================================== */

/** Los breakpoints de Tailwind, en px. Una sola tabla: la usan las tres cuentas. */
const BREAKPOINT_PX: Record<string, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
};

/** Ancho en px de un `max-w-*`/`w-*` de Tailwind, o `null` si no se entiende. */
function anchoToken(token: string, vw: number): number | null {
  const [variant, base] = token.includes(":") ? token.split(":") : [null, token];
  const bp = variant ? BREAKPOINT_PX[variant] : 0;
  if (bp === undefined || vw < bp) return null;
  const name = base.replace(/^(?:max-)?w-/, "");
  const calc = name.match(/^\[calc\(100%-([\d.]+)rem\)\]$/);
  if (calc) return vw - Number(calc[1]) * 16;
  if (name === "full") return vw;
  // Escala `max-w` de Tailwind (rem), la misma que el CSS final.
  const REM: Record<string, number> = {
    xs: 20, sm: 24, md: 28, lg: 32, xl: 36, "2xl": 42, "3xl": 48, "4xl": 56,
    "5xl": 64, "6xl": 72, "7xl": 80,
  };
  return REM[name] === undefined ? null : REM[name] * 16;
}

/**
 * El ancho EFFECTIVO de un diálogo a un viewport dado, en px, deducido de la
 * clase efectiva (la misma que se le pasa a Radix, ya mezclada con
 * `tailwind-merge`).
 *
 * Resuelve la cascada como la resuelve el CSS: dentro de una PROPIEDAD gana la
 * variante más alta que esté activa —`sm:w-full` pisa a `w-[calc(100%-2rem)]`, no
 * al revés— y el ancho final es el menor entre `width` y `max-width`. Medir el
 * menor de todas sería más fácil y MENTIRÍA justo en el caso que importa: con
 * `sm:w-full` solo, a 1024 daría 992 cuando el navegador pinta 1024.
 */
function anchoEfectivo(tokens: string[], vw: number): number {
  const gana = (property: "w" | "max-w"): number | null => {
    let elegido: { bp: number; px: number } | null = null;
    for (const token of tokens) {
      const [variant] = token.includes(":") ? token.split(":") : [null];
      const bp = variant ? BREAKPOINT_PX[variant] : 0;
      if (bp === undefined) continue;
      if (property === "w" ? !/^(?:(?:sm|md|lg|xl|2xl):)?w-/.test(token)
                           : !/^(?:(?:sm|md|lg|xl|2xl):)?max-w-/.test(token)) continue;
      const px = anchoToken(token, vw);
      if (px === null) continue;
      if (elegido === null || bp >= elegido.bp) elegido = { bp, px };
    }
    return elegido?.px ?? null;
  };
  const candidatos = [gana("w"), gana("max-w")].filter((px): px is number => px !== null);
  return candidatos.length === 0 ? vw : Math.min(...candidatos);
}

/* ==========================================================================
   LA CUENTA QUE ANTES ERA UN SELLO DE GOMA.

   La segunda mitad de «el gutter se sostiene…» comparaba el ancho del diálogo
   contra esto:

       pedido = max() de anchoToken(t, 1920) sobre TODOS los tokens, < 1920

   Eso NO era el máximo del llamador: era una CONSTANTE. `w-[calc(100%-2rem)]`
   está en la lista de tokens, y a 1920 vale 1888, así que `pedido` salía 1888
   para los seis diálogos y para cualquier otro. Y como el bucle solo sube
   hasta 1920, `ancho <= vw−32` ya implica `ancho <= 1888`: la segunda mitad
   NO PODÍA fallar sola. Replay: con `sm:max-w-[calc(100%-2rem)]` en la base el
   diálogo de emisión mide 1408 a 1440 y la comparación da `1408 <= 1888`.

   Lo que se afirma ahora, por el mismo caso pero por el MECANISMO:

     1. la base NO reclama un tope de ancho con VARIANTE, porque un `sm:max-w-*`
        sobrevive al `twMerge` contra el `max-w-*` sin variante del llamador y
        en el CSS emitido gana por el media query — y no porque el llamador no
        lo pidiera;
     2. el ancho se compara contra el máximo que PIDIÓ ESE llamador, deducido de
        las clases de ESE llamador. Un `max-w-4xl` son 896 y un `max-w-lg` son
        512, y el diálogo no puede pasar de ahí a NINGÚN ancho de pantalla.
   ========================================================================== */

/**
 * Los reclamos de ANCHO de la base que llevan VARIANTE: `sm:w-full`, `lg:max-w-*`…
 *
 * El criterio es la PROPIEDAD y no el nombre del token. `sm:w-full` era lo que
 * se afirmaba y `md:w-full` o `2xl:w-*` pisan el gutter exactamente igual, sin
 * que nada los mirara. Dentro de una misma propiedad gana la variante más alta
 * que esté activa, así que un solo reclamo con variante alcanza para borrar el
 * `w-[calc(100%-2rem)]` de la base desde 640 en adelante.
 */
function claimsDeAnchoConVariante(base: string): string[] {
  return classTokens(base).filter((token) => /^(?:sm|md|lg|xl|2xl):(?:max-)?w-/.test(token));
}

/** Los `max-w-*` que la BASE declara, con o sin variante. */
function topesDeLaBase(base: string): string[] {
  return classTokens(base).filter((token) => /^(?:(?:sm|md|lg|xl|2xl):)?max-w-/.test(token));
}

/**
 * Los `max-w-*` DE LA BASE que quedan en la clase efectiva SIN QUE EL LLAMADOR
 * LOS HAYA PEDIDO: los que se le imponen por encima de su pedido.
 *
 * Un `max-w-lg` sin variante en la base NO aparece acá cuando el llamador pide
 * un máximo: `tailwind-merge` lo descarta porque es el mismo grupo. Un
 * `sm:max-w-*` sí aparece, y por eso es el que rompe. El criterio no prohíbe
 * ningún nombre de token: pregunta qué tope de la base le queda al llamador
 * encima después de la fusión.
 *
 * Un token que el propio llamador declara se descarta de la cuenta: si la base
 * y el llamador piden los mismos 512 px, el `max-w-lg` que sobrevive es el
 * pedido del llamador, no un tope impuesto. Sin esa salvedad, dos de los seis
 * diálogos de facturación —los que piden `max-w-lg`— acusarían a la primitiva
 * por su propio ancho por defecto.
 */
function topesDeLaBaseQuePisanAlLlamador(base: string, caller: string): string[] {
  const efectivo = new Set(effectiveContentClass(base, caller));
  const pedidos = classTokens(caller).filter((token) =>
    /^(?:(?:sm|md|lg|xl|2xl):)?max-w-/.test(token),
  );
  return topesDeLaBase(base).filter((token) => efectivo.has(token) && !pedidos.includes(token));
}

/**
 * El MÁXIMO QUE PIDIÓ EL LLAMADOR a un viewport dado, en px, deducido de las
 * clases DEL LLAMADOR —o `null` si a ese ancho no hay reclamo suyo vigente.
 *
 * Se resuelve la cascada como en `anchoEfectivo`: dentro de una misma propiedad
 * gana la variante más alta que esté activa. Un llamador que no trae `max-w` no
 * PIDE nada y devuelve `null`: no es la base la que debe respectar un pedido que
 * no existe, y compararla contra su propio `max-w-lg` sería la tautología que
 * esta cuenta vino a matar.
 */
function pedidoDelLlamador(caller: string, vw: number): number | null {
  let elegido: { bp: number; px: number } | null = null;
  for (const token of classTokens(caller)) {
    const [variant] = token.includes(":") ? token.split(":") : [null];
    if (variant !== null && BREAKPOINT_PX[variant] === undefined) continue;
    if (!/^(?:(?:sm|md|lg|xl|2xl):)?max-w-/.test(token)) continue;
    const px = anchoToken(token, vw);
    if (px === null) continue;
    const bp = variant === null ? 0 : BREAKPOINT_PX[variant];
    if (elegido === null || bp >= elegido.bp) elegido = { bp, px };
  }
  return elegido?.px ?? null;
}

/** Los llamadores que SÍ piden un máximo, deduplicados por clase efectiva. */
function llamadoresQuePidenToppe(source: string): string[] {
  return [
    ...new Set(
      dialogContentClassNames(source).filter(
        (value): value is string => value !== null && pedidoDelLlamador(value, 1920) !== null,
      ),
    ),
  ];
}

/* ==========================================================================
   Controles negativos.

   Sin estos, un predicado roto —o un `stripComments` que se come el código—
   haría pasar las quince afirmaciones de arriba sobre la nada.
   ========================================================================== */

describe("control negativo: el detector del cajón a mano acusa de verdad", () => {
  it("reporta un panel escrito a mano", () => {
    const sample = '<div role="dialog" aria-modal="true" className="absolute left-0 top-0" />';
    expect(handRolledDrawer(sample)).toEqual([
      'role="dialog" escrito a mano',
      'aria-modal="true" escrito a mano',
    ]);
  });

  it("no confunde el diálogo de la PRIMITIVA con uno escrito a mano", () => {
    // El `DialogPrimitive.Content` de `dialog.tsx` es el que emite
    // `role="dialog"` y `aria-modal`: el predicado mira el JSX del ARCHIVO que
    // se le pasa, no el DOM que Radix genera en tiempo de ejecución.
    expect(handRolledDrawer(DIALOG_CODE)).toEqual([]);
  });

  it("no cuenta un atributo explicado en un comentario", () => {
    expect(handRolledDrawer('// <div role="dialog" aria-modal="true" />')).toEqual([]);
  });
});

describe("control negativo: el `sm:p-6` de la base es un marco, no una decoracion", () => {
  it("un `p-0` sin su `sm:p-0` deja sobrevivir `sm:p-6`, y el detector lo acusa", () => {
    // Esta es la EXACTA clase del llamador de uno de los seis dialogos, sin el
    // opt-out. Si `survivingPaddingVariants` devolviera `[]` aca, la afirmacion
    // de arriba no probaria nada.
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    expect(survivingPaddingVariants(base, "max-w-5xl border-0 bg-transparent p-0 shadow-none")).toEqual([
      "sm:p-6",
    ]);
  });

  it("con `sm:p-0` declarado el mismo dialogo queda limpio", () => {
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    expect(
      survivingPaddingVariants(base, "max-w-5xl border-0 bg-transparent p-0 sm:p-0 shadow-none"),
    ).toEqual([]);
  });

  it("las dos mitades del opt-out sobreviven a la fusion y las dos dicen cero", () => {
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    const paddings = effectiveContentClass(
      base,
      "max-w-5xl border-0 bg-transparent p-0 sm:p-0 shadow-none",
    ).filter((token) => /^(?:(?:sm|md|lg|xl|2xl):)?p[a-z]?-/.test(token));
    expect([...paddings].sort()).toEqual(["p-0", "sm:p-0"]);
  });
});

describe("control negativo: el detector del nombre accesible acusa de verdad", () => {
  const RADIX_TITLE = `const DialogTitle = React.forwardRef<HTMLHeadingElement, DialogTitleProps>(
  ({ className, ...props }, ref) => (
    <DialogPrimitive.Title ref={ref} className={cn('text-lg', className)} {...props} />
  ))
DialogTitle.displayName = DialogPrimitive.Title.displayName`;

  it("un `<h2>` pelado es exactamente el defecto medido", () => {
    // El estado previo de `dialog.tsx:307`: mismo `h2`, misma clase, sin `id`.
    // Con esto adentro, `name=""` con el texto a la vista es lo esperable.
    const antes = RADIX_TITLE.replace(
      /<DialogPrimitive\.Title/,
      '<h2',
    ).replace("DialogTitle.displayName = DialogPrimitive.Title.displayName", 'DialogTitle.displayName = "DialogTitle"');
    expect(dialogAnnouncementBlock(antes, "DialogTitle")).toBe("<h2");
  });

  it("el mismo texto con el título de Radix no acusa nada", () => {
    // Si el detector no distinguiera los dos, la afirmación de arriba probaría
    // que el fuente tiene una cadena, no que el nombre se arma.
    expect(dialogAnnouncementBlock(RADIX_TITLE, "DialogTitle")).toBe("");
    expect(
      RADIX_TITLE,
      "el detector no se cuelga del `displayName` que ya decía `DialogPrimitive.Title`",
    ).toContain("DialogPrimitive.Title.displayName");
  });

  it("un `<p>` pelado en la descripción es el mismo defecto un peldaño abajo", () => {
    const descPelada = `const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  DialogDescriptionProps
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('text-sm', className)} {...props} />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName`;
    // Nótese que el `displayName` YA decía `DialogPrimitive.Description`: el
    // nombre mentía mientras el elemento era pelado. Es el mismo patrón.
    expect(dialogAnnouncementBlock(descPelada, "DialogDescription")).toBe("<p");
  });
});

describe("control negativo: el gutter se sostiene donde `max-w` alcanza el viewport", () => {
  const LLAMADOR = "max-w-5xl border-0 bg-transparent p-0 sm:p-0 shadow-none";
  // La clase base tal como estaba ANTES de `sm:max-w-[calc(100%-2rem)]`: el
  // estado que Chromium midió en gutter 0/0 a 1024.
  const BASE_ANTES =
    "fixed left-1/2 top-1/2 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 sm:w-full sm:p-6";

  it("la cuenta acusa el estado previo: a 1024 el diálogo se comía el gutter", () => {
    expect(anchoEfectivo(effectiveContentClass(BASE_ANTES, LLAMADOR), 1024)).toBe(1024);
    expect(anchoEfectivo(effectiveContentClass(BASE_ANTES, LLAMADOR), 1024)).toBeGreaterThan(1024 - 32);
  });

  it("y con el tope nuevo el mismo diálogo deja 1 rem por lado", () => {
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    expect(anchoEfectivo(effectiveContentClass(base, LLAMADOR), 1024)).toBe(992);
  });

  it("arriba del `max-w` no se mueve: a 1440 el gutter no toca el ancho pedido", () => {
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    // 1024 es el `max-w-5xl` del llamador y 1440−32 = 1408 no lo toca: el
    // diálogo mide lo mismo que antes del arreglo.
    expect(anchoEfectivo(effectiveContentClass(base, LLAMADOR), 1440)).toBe(1024);
  });

  it("el arreglo que NO se usó cumplía el gutter y rompía el documento", () => {
    // La razón de que el arreglo sea quitar `sm:w-full` y no topar el `max-w`.
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    const conTope = effectiveContentClass(base, `${LLAMADOR} sm:w-full sm:max-w-[calc(100%-2rem)]`);
    // El gutter se cumple...
    expect(anchoEfectivo(conTope, 1024)).toBeLessThanOrEqual(1024 - 32);
    // ...y el `max-w-5xl` del llamador queda pisado: la factura se estiraba.
    expect(anchoEfectivo(conTope, 1440)).toBeGreaterThan(1024);
  });

  it("un `w-full` del llamador volvería a pegarlo al borde, y la cuenta lo ve", () => {
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    const conW = effectiveContentClass(base, `${LLAMADOR} w-full`);
    expect(anchoEfectivo(conW, 1024)).toBeGreaterThan(1024 - 32);
  });
});

/* ==========================================================================
   Control negativo: el `sm:max-w-[calc(100%-2rem)]` —el arreglo «obvio» que se
   descartó— hace FALLAR las dos mitades nuevas, y la cuenta VIEJA no lo veía.

   Esta es la replay que sostiene todo lo de arriba, con los números, no con una
   palabra: con `sm:max-w-[calc(100%-2rem)]` en la base, el diálogo de emisión
   mide 1408 px a 1440 contra los 1024 que pidió su `max-w-5xl`.
   ========================================================================== */

describe("control negativo: la regresión que la segunda mitad NO veía", () => {
  const LLAMADOR = "max-w-5xl border-0 bg-transparent p-0 sm:p-0 shadow-none";
  // La base REAL con `sm:max-w-[calc(100%-2rem)]` agregado, token por token
  // como está en `dialog.tsx`. No es una base inventada: es la que el repo tuvo
  // en tela de juicio, con un token más.
  const BASE_CON_TOPE =
    "fixed left-1/2 top-1/2 grid w-[calc(100%-2rem)] max-w-lg sm:max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg border border-border-color bg-surface p-4 shadow-xl outline-none transition duration-150 sm:p-6";

  it("la cuenta VIEJA daba verde: `pedido` era la constante 1888", () => {
    const tokens = effectiveContentClass(BASE_CON_TOPE, LLAMADOR);
    // La fórmula exacta que estaba en el archivo: el MÁXIMO de lo que vale cada
    // token a 1920, dejando fuera los que dan 1920.
    const pedidoViejo = Math.max(
      ...tokens
        .map((t) => anchoToken(t, 1920))
        .filter((px): px is number => px !== null && px < 1920),
    );
    expect(pedidoViejo, "el `pedido` viejo no dependía del llamador: era 1888").toBe(1888);
    // Y el mismo 1888 salía para un `max-w-lg`, o sea que la comparación no
    // estaba mirando al llamador: miraba al viewport.
    const pedidoOtroLlamador = Math.max(
      ...effectiveContentClass(BASE_CON_TOPE, "max-w-lg p-0 sm:p-0")
        .map((t) => anchoToken(t, 1920))
        .filter((px): px is number => px !== null && px < 1920),
    );
    expect(pedidoOtroLlamador).toBe(pedidoViejo);

    // El defecto medido, y las dos mitades viejas pasándolo.
    const ancho = anchoEfectivo(tokens, 1440);
    expect(ancho, "el diálogo de emisión mide 1408px a 1440 con la regresión viva").toBe(1408);
    expect(ancho, "gutter: 1440−32 = 1408, la primera mitad sigue verde").toBeLessThanOrEqual(1408);
    expect(ancho, "máximo: 1408 <= 1888, la segunda mitad también").toBeLessThanOrEqual(pedidoViejo);
  });

  it("el criterio de la base la acusa: un `max-w` con variante, y uno que sobrevive", () => {
    // Por la PROPIEDAD, no por el nombre del token: el token que se descartó hoy
    // es `sm:`, pero `md:max-w-[…]` rompe exactamente igual y el criterio lo ve
    // sin que nadie lo nombre.
    expect(
      claimsDeAnchoConVariante(BASE_CON_TOPE),
      "un `max-w` con variante en la base es una regresión",
    ).toEqual(["sm:max-w-[calc(100%-2rem)]"]);
    expect(
      claimsDeAnchoConVariante(
        BASE_CON_TOPE.replace("sm:", "md:"),
      ),
      "el mismo defecto con otra variante sigue siendo el mismo defecto",
    ).toEqual(["md:max-w-[calc(100%-2rem)]"]);
    // Y una base sin ningún reclamo con variante queda limpia: el predicado no
    // está verde porque no mire, está verde porque no hay nada que mirar.
    expect(
      claimsDeAnchoConVariante(BASE_CON_TOPE.replace("sm:max-w-[calc(100%-2rem)] ", "")),
    ).toEqual([]);

    // Por la mitad que no lee variantes: el tope de la base sobrevive al
    // `twMerge` del llamador y se le queda encima.
    expect(topesDeLaBaseQuePisanAlLlamador(BASE_CON_TOPE, LLAMADOR)).toEqual([
      "sm:max-w-[calc(100%-2rem)]",
    ]);
    // Con la misma base SIN el token, el `max-w-lg` de la primitiva NO sobrevive
    // a un llamador que pide tope: lo descarta `tailwind-merge` porque es el
    // mismo grupo. Y un llamador que pide el mismo `max-w-lg` que la base
    // tampoco lo acusa: ese `max-w` es suyo, no un tope impuesto.
    const baseSana = BASE_CON_TOPE.replace("sm:max-w-[calc(100%-2rem)] ", "");
    expect(topesDeLaBaseQuePisanAlLlamador(baseSana, LLAMADOR)).toEqual([]);
    expect(topesDeLaBaseQuePisanAlLlamador(baseSana, "max-w-lg p-0 sm:p-0")).toEqual([]);
    expect(
      topesDeLaBaseQuePisanAlLlamador(BASE_CON_TOPE, "max-w-lg p-0 sm:p-0"),
      "con el `sm:max-w-*` sigue acusando aunque el llamador pida `max-w-lg`",
    ).toEqual(["sm:max-w-[calc(100%-2rem)]"]);
  });

  it("el máximo del LLAMADOR la acusa: 1408 > 1024 y 1408 > 512", () => {
    const tokens = effectiveContentClass(BASE_CON_TOPE, LLAMADOR);
    const pedido5xl = pedidoDelLlamador(LLAMADOR, 1440);
    expect(pedido5xl).toBe(1024);
    expect(anchoEfectivo(tokens, 1440)).toBeGreaterThan(pedido5xl ?? Number.POSITIVE_INFINITY);

    // Y con un llamador que pide menos, que es donde el estiramiento se nota
    // como documento roto: `max-w-lg` son 512 y el diálogo se va a 1408.
    const conLg = effectiveContentClass(BASE_CON_TOPE, "max-w-lg p-0 sm:p-0");
    const pedidoLg = pedidoDelLlamador("max-w-lg p-0 sm:p-0", 1440);
    expect(pedidoLg).toBe(512);
    expect(anchoEfectivo(conLg, 1440)).toBe(1408);
    expect(anchoEfectivo(conLg, 1440)).toBeGreaterThan(pedidoLg ?? Number.POSITIVE_INFINITY);
  });

  it("con la base sin el `sm:max-w-*` el mismo diálogo vuelve a medir 1024 a 1440", () => {
    // El otro estado, con la misma pareja base/llamador: el criterio nuevo no
    // tiene que estar rojo siempre. Con la base de verdad el pedido manda y el
    // gutter también — 1024 a 1440, con 416 de gutter de los 1440.
    const baseSana = BASE_CON_TOPE.replace("sm:max-w-[calc(100%-2rem)] ", "");
    const tokens = effectiveContentClass(baseSana, LLAMADOR);
    const pedido = pedidoDelLlamador(LLAMADOR, 1440);
    expect(pedido).toBe(1024);
    expect(anchoEfectivo(tokens, 1440)).toBe(1024);
    expect(anchoEfectivo(tokens, 1440)).toBeLessThanOrEqual(1440 - 32);
    expect(anchoEfectivo(tokens, 1440)).toBeLessThanOrEqual(pedido ?? Number.POSITIVE_INFINITY);
    // Y los dos criterios que acusan la regresión, en el mismo par.
    expect(claimsDeAnchoConVariante(baseSana)).toEqual([]);
    expect(topesDeLaBaseQuePisanAlLlamador(baseSana, LLAMADOR)).toEqual([]);
  });
});

describe("control negativo: los tokens se cortan enteros", () => {
  it("`w-full-ish` no es `w-full`, y `sm:w-full` no matchea `w-full`", () => {
    expect(hasClassToken('"w-full-ish"', "w-full")).toBe(false);
    expect(hasClassToken('"sm:w-full"', "w-full")).toBe(false);
    expect(hasClassToken('"sm:w-full"', "sm:w-full")).toBe(true);
  });

  it("`p-6` no hace pasar `p-4`, y `max-h-[calc(100vh-2rem)]` no es el `dvh`", () => {
    expect(hasClassToken('"p-6"', "p-4")).toBe(false);
    expect(hasClassToken('"max-h-[calc(100vh-2rem)]"', "max-h-[calc(100dvh-2rem)]")).toBe(false);
  });
});

describe("control negativo: el pie sin anclar NO pasa la guarda de R32", () => {
  it("un `DialogFooter` sin `sticky` es exactamente el defecto medido", () => {
    // El estado previo de `form-dialog.tsx:198` era `className="mt-4"`. La
    // guarda tiene que fallar contra él; si lo aceptara, la afirmación de
    // arriba no probaría nada.
    const antes = jsxBlock('<DialogFooter className="mt-4">', "DialogFooter");
    const literal = antes.match(/className="([^"]*)"/);
    expect(literal?.[1]).toBe("mt-4");
    expect(hasClassToken(literal?.[1] ?? "", "sticky")).toBe(false);
    expect(hasClassToken(literal?.[1] ?? "", "bottom-0")).toBe(false);
  });
});
/* ==========================================================================
   R-C — EL CIERRE DEL DIÁLOGO: MECANISMO, PRESENCIA, NOMBRE Y CAJA EFECTIVA.

   MEDIDO antes de este cambio (Chromium, 320/412/1024, con la sesión puesta y
   sin enviar nada): 0 de los 29 `DialogContent` del árbol tienen un control de
   cierre VISIBLE. Se cierran con «Cancelar» o con Escape —y en un teléfono no
   hay tecla Escape—, y los seis diálogos de hoja completa de facturación no
   usan ni una vez `DialogClose`, o sea que dependen por completo de sus
   propios botones.

   Y el componente que debería cerrar NO cierra: `DialogClose` renderizaba un
   `Slot` pelado (o un `<button>`), no `DialogPrimitive.Close`. Es el mismo
   defecto que tuvo `DialogTrigger` en 69b4d1e, un peldaño más abajo, con una
   diferencia importante: aquel se notaba al ABRIR; este no se nota NADA,
   porque nadie lo usa. Un botón de cierre construido sobre él no cerraría el
   diálogo —el cierre vive en Radix (`onOpenChange(false)`)—, o sea que el
   defecto está dormido y no es inocuo.

   Lo que se afirma acá, y por qué cada punto es un CRITERIO y no el nombre de
   un token:

     1. MECANISMO: `DialogClose` renderiza `DialogPrimitive.Close`. El tipo, el
        `displayName` y el `asChild` no abren nada — es el mismo punto ciego que
        `dialogAnnouncementBlock` ya persiguió con el `<h2>` pelado del título.
     2. PRESENCIA: `DialogContent` lo monta, DENTRO de `DialogPrimitive.Content`.
        Esta es la parte que paga en las 29 pantallas: el arreglo va en la
        primitiva y no en 29 llamadores.
     3. NOMBRE: el cierre tiene nombre accesible no vacío («Cerrar»).
     4. CAJA EFECTIVA: 44×44 por debajo de `sm` y NO ESCONDIDO a ningún ancho,
        resuelto por cascada como la resuelve el CSS.
     5. RECORTE: el cierre no se sale de la caja del diálogo, porque hay
        llamadores que la recortan (`overflow-hidden`: 3 de los 29, contados).
     6. FONDO PROPIO: se pinta su propio fondo, así que un diálogo
        `bg-transparent` (los seis de hoja completa) no lo vuelve invisible.

   4, 5 y 6 NO buscan un token: resuelven la clase con el MISMO `twMerge` que
   usa `cn`, ganan dentro de cada propiedad por peso de cascada como el motor,
   y se leen sobre el conjunto REAL de llamadores del árbol. Los controles
   negativos del final reproducen con literales el estado de antes.

   LO QUE ESTA GUARDA NO PUEDE AFIRMAR, DICHO DE ANTEMANO: que el control se
   VEA y que al clickearlo el diálogo SE CIERRE. Un `readFileSync` no abre un
   navegador ni recibe un click; el contraste sobre la hoja de papel y el
   cierre por click se midieron aparte en Chromium real. Una guarda de fuente
   que fingiera medir el click sería un sello de goma.
   ========================================================================== */

/** El cuerpo de `DialogContent`: lo que va DENTRO de `DialogPrimitive.Content`. */
function cuerpoDelContent(): string {
  const clean = stripComments(DIALOG);
  const abre = clean.indexOf("<DialogPrimitive.Content");
  const cierra = clean.indexOf("</DialogPrimitive.Content>");
  if (abre < 0 || cierra < 0) {
    throw new Error("`DialogContent` no declara el par `DialogPrimitive.Content`");
  }
  return clean.slice(abre, cierra + "</DialogPrimitive.Content>".length);
}

/**
 * La pieza CULPABLE de `DialogClose` cuando no renderiza el cierre de Radix;
 * `""` cuando sí lo hace.
 *
 * `dialogAnnouncementBlock` resuelve el mismo juicio para `DialogTitle`: el tipo
 * y el `displayName` ya decían `DialogPrimitive.*` mientras el elemento era
 * pelado, así que buscar la cadena no probaba nada. Acá el estado previo es
 * `const Comp = asChild ? Slot : 'button'` —una rama que devuelve el HOST, no
 * el primitivo— y por eso se buscan las dos formas: el host escrito en el JSX
 * (`<Slot`, `<button`) y la rama `asChild`.
 */
function dialogCloseBlock(): string {
  const declaration = constDeclaration(DIALOG_CODE, "DialogClose");
  if (/<DialogPrimitive\.Close\b/.test(declaration)) return "";
  const rama = declaration.match(/=\s*asChild\s*\?\s*([A-Za-z]+)\s*:\s*'([^']*)'/);
  if (rama) return `\`${rama[1]} | ${rama[2]}\``;
  const etiqueta = declaration.match(/<(Slot|button)\b/);
  if (etiqueta) return etiqueta[0];
  throw new Error(
    "`DialogClose` no renderiza ni `DialogPrimitive.Close` ni un host identificable: no se puede afirmar el mecanismo",
  );
}

/** El bloque JSX del cierre que `DialogContent` monta, o `""` si no monta ninguno. */
function bloqueDelCierre(): string {
  const cuerpo = cuerpoDelContent();
  const i = cuerpo.indexOf("<DialogClose");
  if (i < 0) return "";
  const end = cuerpo.indexOf(">", i);
  return end < 0 ? "" : cuerpo.slice(i, end + 1);
}

/** Nombre accesible del cierre: `aria-label` o texto `sr-only`. `""` si no tiene. */
function nombreAccesibleDelCierre(bloque: string): string {
  const aria = bloque.match(/aria-label="([^"]*)"/);
  if (aria) return aria[1];
  const soloLector = bloque.match(/className="[^"]*sr-only[^"]*"[^>]*>\s*([^<]*?)\s*</);
  if (soloLector) return soloLector[1];
  return "";
}

/** La clase BASE que la primitiva le impone al cierre. */
function cierreClass(): string {
  const declarada = stripComments(DIALOG).match(
    /const DIALOG_CLOSE_BUTTON_CLASS\s*=\s*\n?\s*'([^']*)'/,
  );
  if (!declarada) throw new Error("`dialog.tsx` no declara `DIALOG_CLOSE_BUTTON_CLASS`");
  // Y que el cierre de `DialogContent` monte ESA constante y no una lista
  // suelta: una constante correcta que nadie usa no prueba nada.
  expect(bloqueDelCierre(), "`DialogContent` monta el cierre").toContain(
    "DIALOG_CLOSE_BUTTON_CLASS",
  );
  return declarada[1];
}

/**
 * Los `<DialogContent>` REALES del árbol, con la clase que cada uno declara.
 *
 * Se leen de `app/` y `src/` en cada corrida, no de una lista escrita a mano:
 * esa lista se quedó vieja el día que otra pantalla abrió su primer diálogo, y
 * una guarda que afirmara sobre 23 de los 29 llamadores sin decirlo sería
 * peor que no tenerla.
 */
function dialogosDelArbol(): { archivo: string; clase: string | null }[] {
  const raiz = process.cwd();
  const encontrados: { archivo: string; clase: string | null }[] = [];
  const visitar = (dir: string): void => {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      const ruta = join(dir, entrada.name);
      if (entrada.isDirectory()) {
        visitar(ruta);
        continue;
      }
      if (!entrada.name.endsWith(".tsx")) continue;
      const fuente = stripComments(readFileSync(ruta, "utf8"));
      for (const segmento of fuente.split("<DialogContent").slice(1)) {
        const bloque = segmento.split("</DialogContent>")[0];
        encontrados.push({
          archivo: relative(raiz, ruta).split(SEPARADOR_DE_RUTA).join("/"),
          clase: bloque.match(/className="([^"]*)"/)?.[1] ?? null,
        });
      }
    }
  };
  for (const carpeta of ["app", "src"]) {
    const dir = join(raiz, carpeta);
    if (existsSync(dir)) visitar(dir);
  }
  return encontrados;
}

/* --------------------------------------------------------------------------
   La clase EFECTIVA del cierre. El mismo `twMerge` que usa `cn` y la misma
   cascada que el CSS: dentro de una PROPIEDAD gana la variante más alta que
   esté ACTIVA y, a igual variante, gana la última escrita.
   -------------------------------------------------------------------------- */

/** El separador de ruta del sistema, sin escribir la barra invertida a mano. */
const SEPARADOR_DE_RUTA = String.fromCharCode(92);

/** Los cortes de Tailwind, en px. Una sola tabla para las tres cuentas. */
const CORTE_CIERRE_PX: Record<string, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
};

/** El peso de cascada de cada variante: `max-*` pesa MÁS que `min-*`. */
const PESO_VARIANTE_CIERRE: Record<string, number> = {
  sm: 100,
  md: 200,
  lg: 300,
  xl: 400,
  "2xl": 500,
  "max-2xl": 600,
  "max-xl": 700,
  "max-lg": 800,
  "max-md": 900,
  "max-sm": 1000,
};

/**
 * Variantes que NO son de ancho de pantalla: de estado o de seudoclase.
 *
 * `disabled:pointer-events-none` está en la base de los botones de este repo y
 * es la razón de que esta cuenta sea explícita: en REPOSO ese token no aplica,
 * y una guarda que lo leyera como «el control no recibe el clic» acusaría a
 * todos los botones de la aplicación.
 */
const VARIANTE_DE_ESTADO =
  /^(hover|focus|focus-visible|active|disabled|checked|indeterminate|dark|group-hover|group-focus|peer-checked|aria-|data-\[|placeholder|before|after|file|marker|selection|first|last|odd|even|motion-safe|motion-reduce|print|rtl|ltr)/;

function variantesDe(token: string): string[] {
  return token.split(":").slice(0, -1);
}

function baseDe(token: string): string {
  const corte = token.indexOf(":");
  return corte === -1 ? token : token.slice(corte + 1);
}

/** Los tokens que el navegador tiene ACTIVOS en reposo a ese ancho. */
function enReposo(clase: string, vw: number): string[] {
  return twMerge(clase)
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => {
      for (const variante of variantesDe(token)) {
        if (VARIANTE_DE_ESTADO.test(variante)) return false;
        const esMax = variante.startsWith("max-");
        const corte = CORTE_CIERRE_PX[esMax ? variante.slice(4) : variante];
        if (corte === undefined) return false;
        if (esMax ? vw >= corte : vw < corte) return false;
      }
      return true;
    });
}

/** El valor en px de un token de medida (`size-11`, `h-10`, `min-w-11`…), o `null`. */
function pxDe(token: string): number | null {
  const numero = token.match(/(\d+(?:\.\d+)?)$/)?.[1];
  return numero === undefined ? null : Number(numero) * 4; // 1 = 0.25rem
}

/** El peso de cascada de un token, sin importar de qué propiedad sea. */
function pesoDeCascada(token: string): number {
  const variantes = variantesDe(token);
  return variantes.length === 0 ? 0 : (PESO_VARIANTE_CIERRE[variantes[variantes.length - 1]] ?? 0);
}

/** El valor de una PROPIEDAD, ganando por peso de cascada y luego por orden. */
function propiedadDe(tokens: string[], esDe: (token: string) => boolean): number | null {
  let elegido: { peso: number; px: number } | null = null;
  for (const token of tokens) {
    if (!esDe(token)) continue;
    const px = pxDe(token);
    if (px === null) continue;
    const peso = pesoDeCascada(token);
    if (elegido === null || peso >= elegido.peso) elegido = { peso, px };
  }
  return elegido?.px ?? null;
}

/**
 * La caja del cierre en px por eje.
 *
 * `respaldo` es lo que mide el CONTENIDO cuando nadie declara el lado: el `<X>`
 * de 16 px. Un botón de icono no tiene texto y su caja la fija el hijo, así que
 * sin este número el modelo solo serviría para clases con `size-*` explícito —
 * o sea, para la respuesta que ya se sabe.
 */
function cajaDelCierre(
  clase: string,
  vw: number,
  respaldo = 16,
): { ancho: number; alto: number } {
  const tokens = enReposo(clase, vw);
  const lado = (eje: "w" | "h"): number => {
    const explicito = propiedadDe(
      tokens,
      (token) => baseDe(token).startsWith("size-") || baseDe(token).startsWith(`${eje}-`),
    );
    const piso = propiedadDe(tokens, (token) => baseDe(token).startsWith(`min-${eje}-`));
    // `min-height` le gana a `height` en el CSS — el piso es un PISO, no un
    // valor entre dos — así que los dos se combinan con el MAYOR en vez de
    // elegir uno. Por eso `h-6 max-sm:min-h-11` mide 44 abajo de `sm` y 24
    // desde `sm`.
    return Math.max(explicito ?? respaldo, piso ?? respaldo);
  };
  return { ancho: lado("w"), alto: lado("h") };
}

/** El token que deja el cierre INVISIBLE (o sin clic) a ese ancho; `""` si se ve. */
function tokenQueEscondeElCierre(clase: string, vw: number): string {
  const tokens = enReposo(clase, vw);
  const ganadorDe = (bases: Set<string>): string | null => {
    let elegido: { token: string; peso: number } | null = null;
    for (const token of tokens) {
      if (!bases.has(baseDe(token))) continue;
      const peso = pesoDeCascada(token);
      if (elegido === null || peso >= elegido.peso) elegido = { token, peso };
    }
    return elegido?.token ?? null;
  };
  // El grupo `display` COMPLETO, no solo los tokens que apagan: un `flex` del
  // llamador también compite por peso de cascada y puede ganarle a un `hidden`
  // pelado. Mirar solo los que apagan le daría la victoria al `hidden` sobre un
  // `max-sm:flex`, que es justo el caso que hay que resolver bien.
  const APAGA_DISPLAY = new Set([
    "hidden", "block", "inline-block", "inline", "flex", "inline-flex", "grid",
    "inline-grid", "table", "contents", "list-item",
  ]);
  const display = ganadorDe(APAGA_DISPLAY);
  if (display !== null && baseDe(display) === "hidden") return display;
  const visibilidad = ganadorDe(new Set(["visible", "invisible", "collapse"]));
  if (visibilidad !== null && baseDe(visibilidad) !== "visible") return visibilidad;
  const opaco = ganadorDe(new Set(["opacity-0"]));
  if (opaco !== null) return opaco;
  const sinCaja = ganadorDe(new Set(["sr-only", "size-0", "w-0", "h-0"]));
  if (sinCaja !== null) return sinCaja;
  // Un control que no recibe el clic existe y no se ve: es el mismo defecto del
  // punto ciego de esta familia, una pantalla más adentro.
  return ganadorDe(new Set(["pointer-events-none"])) ?? "";
}

/** Tokens que SACAN el cierre de la caja del diálogo (y `overflow-hidden` la corta). */
function recorteDelCierre(clase: string, vw: number): string[] {
  return enReposo(clase, vw).filter((token) =>
    /^-(?:top|right|bottom|left|inset|translate)-/.test(baseDe(token)),
  );
}

/** El fondo que el cierre se pinta a sí mismo (`""` si no declara ninguno). */
function fondoDelCierre(clase: string, vw: number): string {
  return enReposo(clase, vw).find((token) => baseDe(token).startsWith("bg-")) ?? "";
}

/** ¿El diálogo no pinta nada? Los de hoja completa declaran `bg-transparent`. */
function fondoTransparente(clase: string, vw: number): boolean {
  return enReposo(clase, vw).some((token) =>
    /^bg-(?:transparent|inherit|current)$/.test(baseDe(token)),
  );
}

/** ¿El diálogo recorta su propia caja? `overflow-hidden` en cualquier eje. */
function recortaLaCaja(clase: string): boolean {
  return classTokens(clase).some((token) => /^overflow/.test(token));
}

describe("R-C: el cierre de la primitiva CIERRA (mecanismo, no declaración)", () => {
  it("`DialogClose` renderiza `DialogPrimitive.Close`, no un host pelado", () => {
    // El estado previo: `const Comp = asChild ? Slot : 'button'`. Con eso el
    // botón se ve, es enfocable y NO CIERRA: el cierre vive en Radix.
    expect(dialogCloseBlock()).toBe("");
  });

  it("el arreglo no rompió la firma pública: `asChild` y el `displayName` de Radix", () => {
    // Lo que el arreglo NO puede cambiar: el tipo y el `displayName` ya decían
    // `DialogPrimitive.Close` mientras el elemento era otro, así que afirmar
    // solamente eso no probaría nada. Lo que se afirma acá es que siguen
    // intactos para los llamadores que ya los usen.
    const tipo = DIALOG_CODE.match(/type DialogCloseProps =[^;]*;/)?.[0] ?? "";
    // El tipo también mentía: declaraba `DialogPrimitive.Close` y no lo
    // renderizaba. Lo que se afirma acá es que la firma sigue siendo la de
    // Radix para los llamadores que ya la usen.
    expect(tipo).toContain("typeof DialogPrimitive.Close");
    expect(tipo).toMatch(/asChild\?:\s*boolean/);
    expect(DIALOG_CODE).toContain("DialogClose.displayName = DialogPrimitive.Close.displayName");
  });
});

describe("R-C: TODO diálogo tiene un cierre visible, sin tocar los 29 llamadores", () => {
  it("`DialogContent` monta el cierre DENTRO de `DialogPrimitive.Content`", () => {
    // Esta es la afirmación que paga en las 29 pantallas: el cierre vive en la
    // primitiva, no en un llamador. Si viviera en un modal, el siguiente
    // diálogo volvería a no tenerlo.
    expect(bloqueDelCierre(), "`DialogContent` renderiza `<DialogClose …>`").not.toBe("");
    // Y exactamente uno: dos cierres en el mismo diálogo es un hallazgo, no una
    // robustez.
    expect(cuerpoDelContent().match(/<DialogClose\b/g) ?? []).toHaveLength(1);
  });

  it("el cierre se pinta su propio fondo: un diálogo transparente no lo borra", () => {
    // Los seis diálogos de hoja completa de facturación son `bg-transparent`
    // con la hoja de papel ADENTRO. Un cierre que tomara el fondo del
    // contenedor se volvería invisible sobre la concha oscura: por eso el
    // criterio es «declara su propio fondo», no «tiene fondo».
    const transparentes = dialogosDelArbol().filter(
      (dialogo) => dialogo.clase !== null && fondoTransparente(dialogo.clase as string, 1024),
    );
    expect(transparentes.length, "hay diálogos de hoja completa (`bg-transparent`)").toBeGreaterThan(
      0,
    );
    const fondo = fondoDelCierre(cierreClass(), 1024);
    expect(fondo, "el cierre declara su propio fondo").not.toBe("");
    expect(fondo, "y no es un fondo que no pinta nada").not.toMatch(
      /^bg-(?:transparent|inherit|current)$/,
    );
  });

  it("la clase del cierre NO se fusiona con la del llamador: nadie puede tumbarla", () => {
    // La razón de que el piso se sostenga es que el cierre que `DialogContent`
    // monta no es parametrizable por el llamador: su `className` es la
    // constante, no `cn(constante, props.className)`.
    expect(bloqueDelCierre()).toContain("DIALOG_CLOSE_BUTTON_CLASS");
    expect(bloqueDelCierre()).not.toContain("className={cn(");
  });

  it("el cierre no se sale de la caja del diálogo en los llamadores que la recortan", () => {
    // Hay 3 de los 29 que la recortan (`overflow-y-hidden` en el de emisión y
    // en el cajón, `overflow-hidden` en inventario). Un cierre empujado hacia
    // afuera con `-top-*`/`-right-*` se cortaría por la mitad ahí y no en los
    // otros 26, que es la peor forma de fallar: verde en la mayoría.
    const recortan = dialogosDelArbol().filter(
      (dialogo) => dialogo.clase !== null && recortaLaCaja(dialogo.clase as string),
    );
    expect(recortan.length, "hay diálogos que recortan su propia caja").toBeGreaterThan(0);
    for (const vw of [320, 412, 1024]) {
      expect(recorteDelCierre(cierreClass(), vw), `a ${vw}px`).toEqual([]);
    }
  });
});

describe("R-C: el cierre se nombra, se toca y se ve", () => {
  it("tiene nombre accesible: «Cerrar»", () => {
    // Un `<X>` pelado es un botón sin nombre: el lector de pantalla anuncia un
    // botón y el `elementFromPoint` de la medición no tiene con qué nombrarlo.
    expect(nombreAccesibleDelCierre(bloqueDelCierre())).toBe("Cerrar");
  });

  it("el icono es decorativo: el nombre lo da la etiqueta, no el dibujo", () => {
    // Un icono sin `aria-hidden` entra al nombre accesible y lo ensucia
    // («Cerrar, gráfico»). El criterio es que el nombre sea EXACTAMENTE el
    // declarado, y el `aria-hidden` es lo que lo sostiene.
    const cuerpo = cuerpoDelContent();
    const i = cuerpo.indexOf("<X");
    expect(i, "el cierre dibuja un icono `<X>`").toBeGreaterThan(-1);
    const fin = cuerpo.indexOf(">", i);
    expect(cuerpo.slice(i, fin + 1)).toContain('aria-hidden="true"');
  });

  it("llega a 44×44 por debajo de `sm`, en el último píxel del rango inclusive", () => {
    const clase = cierreClass();
    // 639 y no 640: es donde la variante `max-sm:` sigue activa y donde un
    // breakpoint mal escrito deja el control 8 px corto sin que nadie lo note.
    for (const vw of [320, 360, 412, 639]) {
      const caja = cajaDelCierre(clase, vw);
      expect(caja.ancho, `ancho a ${vw}px`).toBeGreaterThanOrEqual(44);
      expect(caja.alto, `alto a ${vw}px`).toBeGreaterThanOrEqual(44);
    }
  });

  it("el escritorio conserva la densidad que declara (36×36), sin piso móvil", () => {
    // Arriba de `sm` NO hay piso declarado: el escritorio es lo que dice la
    // clase, y se congela para que un `sm:min-h-11` futuro no lo levante sin
    // que nadie lo note (el mismo motivo por el que `touch-floor.test.ts`
    // congela los 38 px del botón del shell).
    expect(cajaDelCierre(cierreClass(), 1024)).toEqual({ ancho: 36, alto: 36 });
  });

  it("el cierre NO está escondido a ningún ancho, y recibe el clic", () => {
    // El punto ciego de la familia, por cuarta vez y en su forma más
    // discreta: un `hidden` o un `pointer-events-none` agregado a la lista
    // deja el piso INTACTO y el control sin verse o sin poder tocarse. Una
    // guarda que sólo mira alto y ancho no lo vería.
    const clase = cierreClass();
    for (const vw of [320, 412, 639, 1024]) {
      expect(tokenQueEscondeElCierre(clase, vw), `a ${vw}px`).toBe("");
    }
  });
});

/* ==========================================================================
   Controles negativos de R-C.

   Sin ellos, un predicado roto —o un `stripComments` que se come el código—
   haría pasar las nueve afirmaciones de arriba sobre la nada. Cada control
   reproduce con literales el estado de antes o el defecto que la sección tiene
   que acusar.
   ========================================================================== */

describe("control negativo: el mecanismo del cierre acusa el `Slot` pelado", () => {
  // El estado previo de `dialog.tsx`, con la misma firma y el mismo
  // `displayName`: el tipo mentía y el elemento era otro.
  const DECLARACION_ANTES = `const DialogClose = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  DialogCloseProps
>(({ className, children, type, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp ref={ref} type={type ?? 'button'} className={cn('inline-flex h-10', className)} {...props}>
      {children}
    </Comp>
  )
})
DialogClose.displayName = DialogPrimitive.Close.displayName`;

  it("la declaración de antes es exactamente el defecto: un `Slot` pelado", () => {
    // Si el predicado no la acusa, la afirmación de arriba probaría que el
    // fuente tiene una cadena `DialogPrimitive.Close` —y el `displayName` la
    // tenía— no que el botón cierre el diálogo.
    const declaracion = DECLARACION_ANTES;
    expect(/<DialogPrimitive\.Close\b/.test(declaracion)).toBe(false);
    const rama = declaracion.match(/=\s*asChild\s*\?\s*([A-Za-z]+)\s*:\s*'([^']*)'/);
    expect(rama?.[1]).toBe("Slot");
    expect(rama?.[2]).toBe("button");
    // Y el mismo juicio, escrito como lo escribe la guarda de arriba.
    const culpable = /<DialogPrimitive\.Close\b/.test(declaracion)
      ? ""
      : `\`${rama?.[1]} | ${rama?.[2]}\``;
    expect(culpable).toBe("`Slot | button`");
  });

  it("el mismo texto con el cierre de Radix no se acusa", () => {
    const sano = DECLARACION_ANTES.replace(
      "const Comp = asChild ? Slot : 'button'",
      "const Comp = DialogPrimitive.Close",
    ).replace("<Comp ", "<DialogPrimitive.Close ");
    expect(sano).toContain("<DialogPrimitive.Close ");
    expect(/<DialogPrimitive\.Close\b/.test(sano)).toBe(true);
    // Y el nombre accesible no se conforma con cualquier cadena: el criterio
    // del nombre se apoya en que exista la etiqueta, no en un texto suelto.
    expect(nombreAccesibleDelCierre('<DialogClose aria-label="Cerrar">')).toBe("Cerrar");
    expect(nombreAccesibleDelCierre("<DialogClose>")).toBe("");
  });
});

describe("control negativo: la caja del cierre se calcula, no se cree", () => {
  it("calibración: el modelo reproduce medidas conocidas", () => {
    // `size-11` son 44 px y `size-9` son 36: los dos números que la sección
    // afirma arriba. Si el modelo no los reproduce, esas afirmaciones no
    // prueban nada: prueban una regla inventada que casualmente coincide.
    expect(cajaDelCierre("size-11", 320)).toEqual({ ancho: 44, alto: 44 });
    expect(cajaDelCierre("size-9", 1024)).toEqual({ ancho: 36, alto: 36 });
    expect(cajaDelCierre("h-10 w-10", 1024)).toEqual({ ancho: 40, alto: 40 });
    // Y el contenido manda cuando nadie declara el lado: el `<X>` de 16 px.
    expect(cajaDelCierre("inline-flex", 1024)).toEqual({ ancho: 16, alto: 16 });
  });

  it("la cascada se resuelve como el CSS: `max-sm:` le gana a la utilidad pelada", () => {
    // Abajo de `sm` la variante negativa gana por peso de cascada; desde 640 se
    // apaga y manda la pelada. Con el signo del peso al revés, la cuenta del
    // piso daría 36 a 320 y la del escritorio daría 44 a 1024.
    expect(cajaDelCierre("size-9 max-sm:size-11", 320)).toEqual({ ancho: 44, alto: 44 });
    expect(cajaDelCierre("size-9 max-sm:size-11", 1024)).toEqual({ ancho: 36, alto: 36 });
    // Y el `min-h` le gana al `height` en el CSS, como en `touch-floor.test.ts`.
    expect(cajaDelCierre("h-6 max-sm:min-h-11", 320).alto).toBe(44);
    expect(cajaDelCierre("h-6 max-sm:min-h-11", 1024).alto).toBe(24);
  });

  it("un `size-6` del llamador se lleva el escritorio, y la cuenta lo ve", () => {
    // La regresión que un token suelto no vería: el llamador fusiona su
    // `size-6` (mismo grupo, misma variante) y el `max-sm:size-11` no compite
    // porque es otra variante. O sea que el piso queda solo abajo de `sm` y el
    // escritorio cae a 24 sin que ninguna cuenta lo advierta.
    const roto = twMerge("size-9 max-sm:size-11", "size-6");
    expect(cajaDelCierre(roto, 320).alto).toBe(44);
    expect(cajaDelCierre(roto, 1024).alto).toBe(24);
    expect(cajaDelCierre(roto, 1024).alto).not.toBe(36);
  });
});

describe("control negativo: el detector de «escondido» y el de recorte acusan", () => {
  it("una clase que lo apaga con el piso puesto sigue siendo un defecto", () => {
    // 44×44 y sin verse, o sin poder tocarse: exactamente el punto ciego. Las
    // cuatro formas que el motor entiende.
    for (const clase of [
      "size-9 max-sm:size-11 hidden",
      "size-9 max-sm:size-11 invisible",
      "size-9 max-sm:size-11 opacity-0",
      "size-9 max-sm:size-11 pointer-events-none",
    ]) {
      expect(tokenQueEscondeElCierre(clase, 320), clase).not.toBe("");
      // Y el piso, intacto: eso es lo que hace el defecto silencioso.
      expect(cajaDelCierre(clase, 320).alto).toBe(44);
    }
    // Una variante de ESTADO no es «escondido»: `disabled:` no aplica en
    // reposo, y tratarlo como tal acusaría a todos los botones del repo.
    expect(tokenQueEscondeElCierre("size-9 disabled:pointer-events-none", 320)).toBe("");
    expect(tokenQueEscondeElCierre("size-9 hover:hidden", 320)).toBe("");
    // Y una variante que sí aplica manda sobre la pelada.
    expect(tokenQueEscondeElCierre("hidden max-sm:flex", 320)).toBe("");
    expect(tokenQueEscondeElCierre("max-sm:hidden", 320)).toBe("max-sm:hidden");
    expect(tokenQueEscondeElCierre("max-sm:hidden", 1024)).toBe("");
  });

  it("el recorte se acusa con literales, y un inset de composición no lo es", () => {
    expect(recorteDelCierre("absolute -top-2 -right-2", 320)).toEqual(["-top-2", "-right-2"]);
    expect(recorteDelCierre("absolute -inset-1", 320)).toEqual(["-inset-1"]);
    expect(recorteDelCierre("absolute -translate-y-1/2", 320)).toEqual(["-translate-y-1/2"]);
    // `inset-0`/`right-2`/`top-2` no sacan nada del cuadro.
    expect(recorteDelCierre("absolute inset-0 right-2 top-2", 320)).toEqual([]);
  });
});

describe("alcance declarado de R-C", () => {
  it("los diálogos del árbol heredan el cierre, y la lista se lee en cada corrida", () => {
    // Si la lista de llamadores fuera una constante escrita a mano, esta cuenta
    // no significaría nada; por eso `dialogosDelArbol()` lee `app/` y `src/`
    // de verdad.
    const dialogos = dialogosDelArbol();
    expect(dialogos.length, "los `DialogContent` que heredan el cierre").toBeGreaterThanOrEqual(20);
    // Y que el total no venga de un archivo solo.
    expect(new Set(dialogos.map((dialogo) => dialogo.archivo)).size).toBeGreaterThanOrEqual(5);
  });

  it("lo que esta guarda NO midió: que el control se vea y que el clic cierre", () => {
    // Sin navegador no hay geometría ni eventos. Lo que sí se midió aparte, en
    // Chromium real a 320/412/1024 sobre un formulario, un confirm y un diálogo
    // de hoja completa: el control existe, mide 44×44 (36×36 desde `sm`), cae
    // dentro del viewport, `document.elementFromPoint` lo devuelve, su nombre
    // accesible es «Cerrar» y un CLIC REAL cierra el diálogo. Y que en los tres
    // diálogos de factura con bloque de cabecera alineado a la derecha el
    // cierre se superpone a ese bloque: se reportó con `path:line` en vez de
    // tocar un archivo que otra persona tenía tomado.
    expect(true).toBe(true);
  });
});
