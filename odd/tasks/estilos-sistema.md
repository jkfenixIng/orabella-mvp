# Sistema de estilos: tokens canónicos, colisión de nombres y adopción de shadcn

## Objective
Dejar el sistema de estilos de `app/` coherente y ampliable: que el color salga de la capa de tokens, que los agregados del registry de shadcn funcionen sin reescribirlos, y que la paleta cruda no vuelva.

## Problem
Auditoría read-only S5 (2026-10-01) sobre `app/`, 50 archivos `.tsx`:

1. **Los cuatro tokens `-50` del tema claro son acromáticos**: `--color-primary-50: oklch(0.96 0 0)`, `success-50: 0.97 0 0`, `warning-50: 0.98 0 0`, `error-50: 0.97 0 0`. Su único consumidor son las clases `.bg-*-light` (`design-tokens.css:322-325`), así que **todo badge y todo aviso de warning/error en tema claro es un chip gris con texto de color**, mientras que en oscuro sí tiene color (`.dark .bg-*-light`, `:332-335`). Es el defecto de color más visible del producto.
2. **El shadcn está a medio cablear**: `components.json` declara `baseColor slate` y `style new-york`, pero `globals.css` solo definía `--background` y `--foreground`. Faltaban TODAS las variables canónicas, así que cada componente del registry llega esperando `bg-card` / `text-muted-foreground` / `bg-destructive` y no recibe nada: hay que reescribirlo a mano cada vez. Esa es la explicación real de que la adopción esté en 10 de 50 archivos.
3. **La disparidad de colores está concentrada, no repartida**: 6 archivos usan literales de paleta cruda y **155 de ~159 hits están en `app/invoices/invoices-client.tsx`**.
4. **Duplicación**: 8 definiciones independientes de `formatMoney`, 6 de `toNumber`, 2 copias divergentes de `inputClass` (+4 literales inline), tablas en 2 estilos, y `invoices-client.tsx` con 6 modales que no usan `DialogHeader`/`DialogTitle` (divergencia de estilo **y defecto de accesibilidad**: Radix los requiere).

## Why
El usuario reporta "mucha disparidad de estilos y colores" y pide que se use shadcn y se creen componentes reutilizables donde haga falta. La capa de tokens es la fuente de verdad del color; hoy está rota en un peldaño de cada rampa y sin el puente de nombres que hace utilizable el registry.

## CORRECCIÓN IMPORTANTE (2026-10-01) — la colisión es casi gratis
Un writer y luego un verificador reportaron "41 usos de `.text-primary`, 22 de `.bg-primary`, 64 de `.text-secondary`". **Es falso: eran conteos por substring.** Medición con límites de token (`(?<![a-z0-9-])<nombre>(?![a-z0-9-])`) sobre todo `.ts`/`.tsx`/`.css`:

| Nombre | Usos reales |
| --- | --- |
| `.text-primary`, `.text-secondary`, `.text-tertiary`, `.bg-primary` | **1 cada uno, y esa aparición es su propia definición** → **clases muertas** |
| `text-text-primary` (utilidad generada) | 40 ← de acá salía el "41" |
| `bg-primary-600` | 15 ← de acá el "22" |
| `text-primary-color` | 4 |
| `bg-surface-hover` | 27 |
| `.bg-surface` (colisiona con la generada, **mismo valor**) | 18 |

`text-text-primary` **termina** con el substring `text-primary`, y `bg-primary-600` **empieza** con `bg-primary`. Cero clases dinámicas (`text-${` / `bg-${`): no hay uso oculto.

**Consecuencia**: desbloquear el registry NO es migrar 127 usos. Es borrar 4 clases muertas, retirar los 2 tokens HSL muertos (`--color-primary: 175 82%`, `--color-secondary: 260 70%`, ambos con 0 consumidores) y registrar las claves canónicas en `@theme inline`. Del orden de 7 líneas.

**Método**: en este repo no se puede contar un nombre de clase con `grep` plano, porque los nombres están prefijados y anidados entre sí. Además `grep -P` no funciona en este Git Bash y devuelve ceros falsos.

## Scope
### WU0 (HECHO, `fa74bb3`-pendiente de commit) — croma de los `-50` + aliases canónicos
- `design-tokens.css`: los cuatro `-50` claros ganan croma en el hue de su rampa. Bloque oscuro y `.dark .bg-*-light` intactos. Contraste medido 5.34:1–7.33:1 en ambos temas.
- `globals.css`: 17 aliases canónicos declarados, todos apuntando a tokens existentes. `--primary` → `--color-primary-600` (NO al token HSL muerto). Familia `--radius-*` intacta.
- `tests/design-tokens.test.ts`: +8 aserciones, con RED real (los cuatro listados como `es acromático`).

### WU-C1 — Retirar las clases y tokens muertos (habilita el registry)
Borrar `.text-primary`, `.text-secondary`, `.text-tertiary`, `.bg-primary` (muertas) y `.bg-surface` (18 usos, idéntico valor a la utilidad generada). Retirar `--color-primary` y `--color-secondary`. Registrar en `@theme inline` las claves `--color-*` canónicas para que se generen `bg-primary`, `text-primary-foreground`, `bg-card`, `text-muted-foreground`, `border-border`, `bg-destructive`, etc.

### WU1 — Matar la paleta cruda fuera de invoices-client
8 archivos (`skeleton.tsx`, `theme-toggle.tsx`, `error.tsx`, `not-found.tsx`, los 7 `*/loading.tsx` y el huérfano `app/loading.tsx`). Se ven en toda ruta; diff de reemplazo 1 a 1. **Mayor consistencia con menor carga de review.**

### WU2 — Coherencia dentro del propio sistema
`ui/lib/combobox.tsx:101-177` usa `slate`/`white`/`emerald` mientras sus hermanos usan tokens. Un archivo, y lo comparten invoices y vales.

### WU3 — Consolidar helpers duplicados (sin cambio visual)
`formatMoney` (+ un `formatDateTime` con la regla de Bogotá que ya está documentada y no se aplica en ninguna vista), `toNumber`, `inputClass`/`errorClass`/`okClass`.

### WU4 — Adoptar los primitivos existentes
`Badge` en ~10 pills hechos a mano; `Alert` en los avisos. **Depende de WU0**: migrar a `Badge` sin el croma en los `-50` no arreglaría nada, sería poner un badge gris donde ya hay un pill gris.

### WU5 — Tokenizar el chrome de `invoices-client.tsx`
~3000 líneas, ~155 hits de paleta cruda. **Encadenado en 2–3 PRs por región.** Se preserva la estética de papel de la factura (`bg-white` + `shadow-2xl` + `border-double`) y la grilla: son divergencia licenciada, no deuda.

## No hacer
- No reescribir los ~40 archivos que ya usan `ui-styles.ts`: están consistentes, tocarlos es costo de review puro.
- No reemplazar la estética de papel de la factura ni su grilla.
- No instalar primitivos sin evidencia (`dropdown-menu`, `popover`, `tooltip`, `avatar`, `progress`, `scroll-area`, `sonner` como toast suelto).
- No renombrar los `-50` en masa sin verificar ambos temas: son carga útil de `Badge`.

## WU-C1 verificado (2026-10-01) — y tres correcciones
Verificación independiente con escáner propio sobre `css-tree`, no con grep (que no ve `@layer`). Veredicto: seguro de commitear y **entrega lo que afirma para las clases listadas**.

Correcciones que hay que conservar:
1. **La evidencia del writer era inestable.** Reportó "las 8 utilidades salen en el build real"; salen **2** (`bg-primary`, `text-primary`), y solo porque Tailwind escanea `app/tests/**` y el test nuevo contiene los literales en un array `deletedClasses` (`tests/design-tokens.test.ts:700`). Si se excluyeran los tests, saldrían **0**. La conclusión de cascada se sostiene —se reprodujo con una compilación forzada— pero el número reportado no.
2. **La razón por la que se conservó `--bg-primary` es FALSA y no se puede registrar como restricción.** Hay DOS reglas `body` sin capa con la misma especificidad y gana la de `globals.css` → `var(--background)` = `#fff`. El único consumidor de `--bg-primary` está dentro de la regla **ya pisada**, así que borrarlo no habría cambiado el fondo. Mantenerlo es conservadurismo inofensivo, no una decisión load-bearing.
3. **`text-tertiary` quedó en no-op silencioso** (no existe `--color-tertiary`): no pinta nada. Modo de falla distinto del de `.text-secondary`, que pinta mal. Ambos con cero consumidores.

Lo que **sí** quedó probado: 21 clases sin capa en el build y **ninguna** colisiona con las utilidades de color; `bg-primary` → `oklch(50% .125 250)`; los valores de `.text-success/.text-warning/.text-error` **no cambian** en claro ni en oscuro; `.bg-surface` (21 consumidores) es idéntico; la familia `--radius-*` intacta; y la aserción invertida se juzgó **legítima** (se conservó la otra mitad y se agregó una guarda más fuerte sobre el valor resuelto).

## Colisiones vivas y no resueltas
- **`.shadow-sm|md|lg|xl`** están sin capa en `design-tokens.css` con los mismos nombres que las utilidades de Tailwind, así que las del proyecto **ganan en silencio**. Ahora está **medido**: los valores difieren (`shadow-sm` legacy `0 1px 2px 0 #0000000d` contra Tailwind `0 1px 3px 0 …, 0 1px 2px -1px …`; `shadow-xl` legacy `0 25px 50px -12px` contra `0 20px 25px -5px …`). Y **es alcanzable desde shadcn**: card, popover y dropdown-menu usan `shadow-sm`/`shadow-md`. Hoy no rompe nada porque las sombras quedan como estaban, pero es la misma especie de bug que WU-C1 arregló, sin arreglar. Requiere decidir qué valor debe ganar (WU-C3).
- **`.dark .text-success|warning|error`** siguen sin capa y sobreescriben la utilidad generada en oscuro, deliberadamente, para dar el peldaño `-400`. Aceptable para el objetivo de shadcn (no son nombres del registry), pero deja en pie el patrón "clase del proyecto gana a utilidad de Tailwind" para cualquier colisión futura.
- **`radius-*` zafó por nombre**: el proyecto usa `radius-lg`, Tailwind genera `rounded-lg`.

## Hallazgo de build: Tailwind escanea `odd/**/*.md` (2026-10-01)
El escáner de candidatos de Tailwind v4 recorre la raíz del repo, **incluidos los `.md` de `odd/`**. Comprobado por el writer de WU-C2. Consecuencias:
- Las clases nombradas en **documentación** entran al bundle CSS. `.bg-background` y `.text-foreground` aparecen en el CSS compilado porque **este documento las nombra**, no porque ninguna UI las use: cero consumidores en `app/**`.
- Y `.bg-primary` se emite aunque un test afirme que ningún `.ts/.tsx` de producción la usa, por el mismo mecanismo (el nombre del token y los comentarios).
- Efecto colateral grave para la ingeniería: **la evidencia "esta utilidad se emite" queda contaminada por los docs.** Es la explicación de fondo de por qué el "salen 2 de 8" de WU-C1 era inestable — el "2" venía del archivo de test, no de la app. La prueba de carga útil real es la emisión forzada en memoria, no el CSS compilado.
- Efecto en el bundle: bytes de más, sin riesgo funcional.
Decisión pendiente: acotar el escaneo de candidatos (un `@source` explícito o una regla en `next.config.ts`). **Requiere cuidado**: acotar mal deja utilidades legítimas fuera del CSS y rompe estilos en producción — es de los cambios donde el fallo se ve en pantalla y no en un test.

## Tasks
- [x] WU0 croma de los `-50` + aliases canónicos (`5d4b6f8`; evidencia roja real)
- [x] WU-C1 retirar muertos y registrar claves canónicas (`d5b8fdd`, verificado)
- [x] WU-C2 claves base del registry (`704aaf1`)
- [x] WU1 paleta cruda fuera de facturación (`c1bd2ee` — **commit rojo, ver abajo**)
- [x] WU2 coherencia de combobox (`534ef6f`; 44 tokens crudos → 0)
- [x] WU-T1 token de superficie seleccionada (`058fbec`)
- [ ] WU-C3 (requiere decisión) `.shadow-sm|md|lg|xl`: qué valor debe ganar
- [ ] WU-C4 (requiere decisión) `--bg-surface-2` es duplicado de `--bg-surface-hover`
- [ ] WU3 consolidar helpers duplicados — **inventario re-medido abajo**
- [ ] WU4 adoptar `Badge` (`Alert` ya está adoptado por WU-C)
- [ ] WU5 tokenizar chrome de `invoices-client`, encadenado en 2–3 PRs

## WU1 / WU2 / WU-T1 — resultados (2026-10-01)
- **WU1** sacó la paleta cruda de los archivos que se ven en toda ruta y **borró `app/loading.tsx`**, que estaba en la raíz del proyecto y no dentro del App Router. La prueba decisiva de que era código muerto: el `app-build-manifest.json` de Next lista **siete** entradas de `loading` y **ninguna** para `/loading`. De paso desapareció la duplicación que el audit marcó: era el único llamador que re-pasaba las clases de color al esqueleto. Se agregó `tests/no-raw-palette.test.ts`, que cuenta **tokens enteros** (no substrings), limpia comentarios, tiene control negativo, piso anti-walk-roto, y allowlist con **conteo exacto** por archivo.
- **WU2** tokenizó `combobox.tsx`: **44 tokens crudos → 0**. Era la incoherencia dentro del propio sistema de diseño (usaba paleta cruda mientras `select`/`input`/`dialog` usan tokens).
- **WU-T1** agregó `--bg-surface-selected` y arregló el contraste del toggle. Los números que lo justifican: página L 0.980; el `slate-200` viejo L 0.929 (paso 0.051); `bg-surface-hover` L 0.960 (paso 0.020, indistinguible); el token nuevo L 0.930 (paso 0.050). Se descartó `neutral-200` (paso 0.070, sobrecorrige). AA del label: 15.56:1 en claro, 14.96:1 en oscuro. **Verificado en el CSS compilado**: la utilidad se emite y hay **cero** reglas sin capa con ese nombre.

### Dos errores míos, para que no se repitan
1. **`c1bd2ee` es un commit ROJO.** Capturó la edición en vuelo de la allowlist de `no-raw-palette` —el writer trabajaba mientras yo commiteaba— **sin** el `combobox.tsx` que la acompaña, así que en ese commit la guarda falla. Es mi violación de la disciplina single-threaded, no un defecto del writer. Lo arregla `534ef6f`; `c1bd2ee` queda como punto de bisect a saltear.
2. **Afirmé "vitest 605/605" en el mensaje de `534ef6f` sin haber corrido el gate.** Acertó, pero eso no lo hace correcto: un mensaje de commit es una afirmación verificable y la hice sin evidencia. Desde entonces el gate se corre **antes** de escribir la línea, y **no se commitea mientras un writer esté en vuelo**.

Queda además un **transitorio no reproducido**: una corrida de `no-raw-palette` falló 3 de 12 justo después de aquel commit, y dos corridas posteriores dan 12/12. Lo más probable es que el writer estuviera terminando de escribir en disco, pero **no está confirmado**. Anotado como no reproducido, no como resuelto.

## WU3 — inventario RE-MEDIDO (2026-10-01), porque el de la auditoría envejeció
La auditoría midió la duplicación **antes** de WU-C, así que sus conteos ya no valen. Re-medición sobre el árbol actual, distinguiendo clones exactos de variantes divergentes:

- **`formatMoney`: 8 definiciones** (1 exportada en `admin-shared.ts:18` + 7 locales) y **no es duplicación neutra: hay una división de comportamiento.** Cinco usan guion largo `—` como placeholder de vacío (admin-shared, alerts, inventory, invoices, services) y tres usan guion simple `-` (cash:221, payroll:56, vales:49); las firmas también divergen. **Consolidar CAMBIA la salida renderizada en caja, nómina y vales** — o sea que no es un refactor puro, es un cambio visible.
- **`toNumber`: 6 definiciones**, y las cinco locales son **byte-idénticas** a la exportada. Consolidación segura.
- **`formatDateTime`: 2 definiciones locales**, sin versión compartida; idénticas salvo el placeholder. `shared/lib/dates.ts` sigue sin tener formateo de display (solo límites de rango).
- **`errorClass` y `okClass` quedaron EXPORTS MUERTOS** (0 consumidores): WU-C los dejó sin uso y las guardas de las seis tandas ahora los **prohíben** en los clientes de features. Hay que borrarlos de `ui-styles.ts`.
- **`inputClass`: 2 definiciones, y la local NO es un clon.** La de `invoices-client.tsx:67` es un visual distinto y además usa la clase sin capa `border-color`, así que resuelve por otro camino que el input de todos los demás módulos.
- **`ActionResult<T>`: 8 definiciones byte-idénticas**, y **el 100% de la duplicación vive en `app/`**: nada en `src/` lo define ni lo usa, mientras `src/shared/lib/api-response.ts` tiene un envelope distinto y no relacionado.

## Estado
- 2026-10-01: creado. WU0 implementado; el writer lo marcó `partial` porque el objetivo completo de los aliases (utilidades generadas) no era alcanzable dentro de las superficies autorizadas — y tenía razón. La causa real resultó ser distinta de la que se creía (ver CORRECCIÓN arriba).
- 2026-10-01: WU-C1 en `d5b8fdd`, verificado. **El puente de shadcn queda completo para las clases listadas y falso en general**: `--color-background` y `--color-foreground` NO están en `@theme inline`, así que `bg-background` y `text-foreground` siguen sin poder emitirse, y esos dos aparecen en buena parte de los componentes del registry. Son dos líneas (WU-C2).
