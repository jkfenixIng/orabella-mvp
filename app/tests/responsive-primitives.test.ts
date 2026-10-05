import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    const content = constDeclaration(DIALOG_CODE, "DialogContent");
    expect(content).not.toMatch(/\baria-label=/);
    expect(content).not.toMatch(/\baria-labelledby=/);
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
  it("deja gutter a los dos lados por debajo de `sm`", () => {
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    // 1 rem de gutter por lado por debajo de `sm`.
    expect(hasClassToken(base, "w-[calc(100%-2rem)]")).toBe(true);
    // Lo que ESTE token afirmaba antes era `sm:w-full`, y era un criterio
    // disfrazado de token: `sm:w-full` PISA a `w-[calc(100%-2rem)]` en la
    // cascada, así que con él el gutter NO se sostenía arriba de `sm` (medido a
    // 1024: gutter 0/0). El criterio ahora vive en `anchoEfectivo`, más abajo.
    // Lo que sí se afirma acá es que la base NO se quite el tope de ancho.
    expect(hasClassToken(base, "sm:w-full")).toBe(false);
  });

  it("el padding baja en el extremo angosto y sube en el ancho", () => {
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    expect(hasClassToken(base, "p-4")).toBe(true);
    expect(hasClassToken(base, "sm:p-6")).toBe(true);
  });

  it("el gutter se sostiene donde `max-w` alcanza el viewport (R7 a 1024)", () => {
    // El criterio, no el token, en las dos mitades: para NINGÚN diálogo, en
    // NINGÚN ancho de pantalla, (1) el ancho efectivo llega al del viewport, ni
    // (2) deja de respetar el `max-w` que le puso el llamador.
    //
    // La segunda mitad no es un detalle: `sm:max-w-[calc(100%-2rem)]` —el
    // arreglo «obvio» que se descartó— cumple la primera y rompe la segunda,
    // porque `max-width` es una sola propiedad y la variante de `sm:` pisa al
    // `max-w-5xl` del llamador. MEDIDO: el diálogo de emisión pasaba de 1024 a
    // 1408 px a 1440. Un guardia que solo mirara el gutter habría dado verde a
    // ese defecto.
    const base = cnBaseClass(DIALOG_CODE, "DialogPrimitive.Content");
    for (const caller of fullBleedClassNames(INVOICES)) {
      const tokens = effectiveContentClass(base, caller);
      const pedido = Math.max(
        ...tokens.map((t) => anchoToken(t, 1920)).filter((px): px is number => px !== null && px < 1920),
      );
      for (const vw of [320, 390, 640, 768, 1024, 1280, 1440, 1920]) {
        const ancho = anchoEfectivo(tokens, vw);
        expect(ancho, `\`${caller}\` a ${vw}px: gutter ≥ 1rem por lado`).toBeLessThanOrEqual(vw - 32);
        expect(ancho, `\`${caller}\` a ${vw}px: no excede el max-w del llamador`).toBeLessThanOrEqual(pedido);
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

/** Ancho en px de un `max-w-*`/`w-*` de Tailwind, o `null` si no se entiende. */
function anchoToken(token: string, vw: number): number | null {
  const [variant, base] = token.includes(":") ? token.split(":") : [null, token];
  const bp = variant
    ? ({ sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 } as Record<string, number>)[variant]
    : 0;
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
      const bp = variant
        ? ({ sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 } as Record<string, number>)[variant]
        : 0;
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