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

## Colisiones vivas detectadas y no resueltas
`.shadow-sm|md|lg|xl` están definidas como clases sin capa en `design-tokens.css:306-309` con los mismos nombres que las utilidades de Tailwind, así que **las del proyecto ganan en silencio**. Hoy `shadow-sm` no vale lo que Tailwind dice. No medido todavía si el valor difiere en la práctica. `radius-*` zafó: el proyecto usa `radius-lg`, Tailwind genera `rounded-lg`.

## Tasks
- [x] WU0 croma de los `-50` + aliases canónicos (576 tests verdes, evidencia roja real)
- [ ] WU-C1 retirar muertos y registrar claves canónicas (habilita el registry)
- [ ] WU1 paleta cruda fuera de invoices-client
- [ ] WU2 coherencia de combobox
- [ ] WU3 consolidar helpers duplicados
- [ ] WU4 adoptar Badge/Alert (depende de WU0)
- [ ] WU5 tokenizar chrome de invoices-client, encadenado

## Estado
- 2026-10-01: creado. WU0 implementado; el writer lo marcó `partial` porque el objetivo completo de los aliases (utilidades generadas) no era alcanzable dentro de las superficies autorizadas — y tenía razón. La causa real resultó ser distinta de la que se creía (ver CORRECCIÓN arriba).
