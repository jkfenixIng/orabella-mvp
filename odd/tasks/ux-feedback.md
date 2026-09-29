# Feedback de UI: `Alert` para estado y toast para eventos

## Objective
Reemplazar el feedback ad-hoc como texto inline por componentes del sistema: un `Alert` inline para mensajes de ESTADO y un toast (primitivo de shadcn) para EVENTOS. Mejorar la UX de los mensajes sin romper las suites e2e que dependen de `role="status"`.

## Problem
- **54 ocurrencias** de `role="status"` / `role="alert"` en 30 archivos. Desglose: 7 en `*/loading.tsx` (esqueletos, uso correcto — **no se tocan**), 8 en `*/page.tsx` (errores del server), **39 en componentes client = el problema**.
- **No existe ningún mecanismo de toast en el proyecto.** Cero. Todo el feedback es un `<p role="status">` persistente.
- **El defecto de fondo no es el color, es que se confunden estado y evento.** "Turno abierto" es un EVENTO y se renderiza como ESTADO, así que queda pegado en pantalla para siempre y compite visualmente con los avisos que sí cambian. Ese es el síntoma que se siente mal.
- `role="status"` (región cortés) y `role="alert"` (región asertiva, interrumpe) se usan intercambiados: algunos errores susurran y algunos éxitos gritan.
- Sin componente canónico, cada pantalla inventó su spelling (`bg-warning-light`, `bg-amber-50`, `errorClass`, …).

## Why
Pedido explícito del usuario: "hay textos que usa como alertas de exitoso error warnings y etc en vez de componentes que se usan regularmente para eso, hay que mejorar la ux en general". Un "✓ turno abierto" que nunca desaparece es el síntoma más visible.

## Decisiones tomadas por el usuario (2026-10-01)
- **Toast sí, y con shadcn.** El primitivo de toast de shadcn es `sonner`, o sea **una dependencia npm nueva** (MIT, chica). Autorizada.
- **"Hay que poder usar lo que se tiene"** → el trabajo del choque de nombres va primero, para poder ampliar los 10 primitivos existentes con componentes del registry.
- Flujo aceptado: A → B → C. Prioridad: choque de nombres primero, después A y B.

## Diseño
| Necesidad | Componente | Rol ARIA |
| --- | --- | --- |
| Estado contextual ("supera el tope", "no hay turno abierto") | `Alert` inline, persistente, junto a lo que describe | `status` para info/éxito de estado, `alert` solo para error que interrumpe |
| Evento ("turno abierto", "vale aprobado") | Toast, transitorio, se va solo | `status` |

Clave: **el éxito de un evento deja de persistir**. Hoy no se puede, porque no hay toast.

## Scope
### WU-A — Primitivos, sin migración
- `app/src/components/ui/lib/alert.tsx` (nuevo; variantes success/warning/destructive/info sobre el vocabulario del proyecto, igual que los otros 10 primitivos)
- `app/src/components/ui/lib/sonner.tsx` + `<Toaster />` montado en el layout
- `package.json` + lockfile: `sonner`
- Test de contrato offline nuevo
- **Condición de fin**: existe el componente y el toast, con test. Cero migración.

### WU-B — Un módulo como patrón de referencia
- Módulo a elegir **sin acoplamiento e2e** (caja queda excluida, ver abajo)
- **Condición de fin**: ese módulo sin `role` ad-hoc; cada mensaje es state o event, y ninguno queda pegado en pantalla

### WU-C — Migración del resto, un commit por módulo
- 39 sitios, más los specs e2e que dependan de ellos, actualizados **a propósito** en el mismo commit

## Restricción de pruebas (medida, no supuesta)
9 specs e2e: `api`, `auth.setup`, `authed`, `cash`, `guards`, `invoices`, `login`, `notfound`, `smoke`.
`tests/e2e/cash.spec.ts` afirma **4 veces** sobre `p[role="status"]` con texto:

```ts
await expect(page.locator('p[role="status"]', { hasText: /turno abierto/i })).toBeVisible()
```

Consecuencias que se respetan:
1. **Caja NO puede ser el módulo de referencia.**
2. Toda migración preserva `role` y el texto, **o** actualiza el spec a propósito en el mismo commit. Nunca romperlo por efecto colateral.

## Tasks
- [x] WU-A primitivos `Alert` + toast (`sonner`) — `bf74ca5`, verificado
- [ ] WU-B módulo de referencia → **`services`** (elegido por evidencia: no aparece en ningún spec)
- [ ] WU-C migración del resto, con los specs que correspondan
- [ ] WU-D (follow-up) tinte por tipo del toast: necesita un override en `globals.css`
- [ ] WU-E (follow-up) corregir el criterio en el comentario de `alertRole()`

## WU-A — resultado y follow-ups (2026-10-01)
Commit `bf74ca5`. Gate: vitest 452/452 (baseline 436), typecheck, lint y `next build` 22/22.

Verificado por mutación: **11 mutaciones inyectadas y cada una atrapada por su guarda** (renombrar una clase del cva, cambiar la pareja de una variante, borrar un override `.dark`, apuntar el fondo oscuro al peldaño `-50`, borrar una clave de `@theme`, hardcodear el `role`, duplicar el `<Toaster />`, vaciar el árbol de fuentes). Y la instalación de `sonner` **no tocó nada más**: lockfile +17/−0, un nodo nuevo, cero entradas reescritas; los "39 removidos" eran deriva extraria (35 nunca declarados, 2 bindings wasm `optional` que npm no materializa en win32-x64); `npm ls --all` sale limpio. Las 2 vulnerabilidades del install son `postcss@8.4.31` fijado por `next@15.5.25`: **pre-existentes y ajenas** a `sonner`, que no tiene dependencias de runtime.

### Follow-ups que la verificación dejó abiertos
1. **Tinte por tipo del toast (WU-D).** No se implementó y no se puede dentro de las superficies de WU-A: en sonner 2.x las variables por tipo solo aplican bajo `data-rich-colors='true'` y sus valores en oscuro son la paleta propia de sonner; y pisarlas con `--color-*-50` tampoco sirve porque **ese peldaño no se invierte en `.dark`** (lo que se invierte es la CLASE `.dark .bg-*-light`), así que en oscuro el toast quedaría casi blanco. Necesita un override en `globals.css`.
2. **El criterio del rol está mal enunciado (WU-E).** El comentario dice, en efecto, "asertivo si es un warning". El invariante correcto es **"asertivo si el usuario tiene que actuar antes de seguir"**. Un warning inline y persistente ya está en el orden de lectura y se va a leer igual; interrumpir solo se gana cuando bloquea el flujo. La decisión por variante queda igual (el copy del proyecto para `warning` es justo de ese tipo), pero el comentario tiene que decir el criterio bueno, no el color.
3. **Dos matices técnicos que conviene dejar escritos:** un nodo `role="alert"` presente en el HTML **inicial** por lo general **no se anuncia** (el rol rinde en inserción dinámica), así que en un `Alert` renderizado por el servidor el rol es inofensivo pero **no load-bearing**; y `role="alert"` implica anuncio **atómico** del nodo completo, lo que es otra razón para mantener los cuerpos cortos.
4. **`classSource` no es un oráculo general de clases.** Solo conoce el vocabulario de color del proyecto: `text-sm`, `rounded-md` y demás resuelven a `null` bajo él. Si alguien aserta una utilidad que no es de color a través de esa función, obtiene un **falso negativo**. Es un riesgo de mal uso latente, no un defecto de las aserciones actuales.
5. **Los pisos son guardas anti-fallo-de-parseo, no de tamaño.** `declaredClasses` tiene **una** unidad de margen (21 contra 20), así que el piso detecta "el parseo murió", no "el vocabulario se achicó". La protección real de las 8 clases son las aserciones por clase, que sí fallan al borrar una.

## WU-B — resultado y la regla que deja para WU-C (2026-10-01)
Modulo `services` migrado (primer patron). Verificado: seguro, build 22/22 en el arbol, transiciones de estado identicas y solo cambia el ciclo de vida del mensaje (pegajoso → efimero). El test falla sobre los archivos previos (8 fallas / 6 pasadas) y 5 mutaciones inyectadas son atrapadas.

**Regla para el resto de WU-C, adoptada de la verificacion:** el placeholder de lista vacia **no es "la excepcion del Alert": es un `EmptyState`.** Nunca llevo `role`, asi que nunca anuncio nada; envolverlo en `Alert` **agrega** un anuncio `aria-live` donde no habia, que es un cambio de conducta fuera de esta unidad. Regla:
- **Evento** → toast.
- **Estado bloqueante** (hay que resolverlo para seguir: fallo al guardar, sin sede) → `Alert`.
- **Estado vacio / placeholder de tabla** (describe el baseline esperado, no bloquea) → texto apagado, **sin** `aria-live`.
Si mas adelante se quiere consistencia visual, corresponde un primitivo `EmptyState` propio (apagado, centrado, sin `aria-live`) usado en todas las areas de tabla. **No** convertirlo en `Alert`.

Matices que dejo la verificacion del test de `services`:
- La suite afirma **estructura sobre texto fuente**, no conducta: las ventanas `[\s\S]{0,160}` toleran codigo arbitrario entre la apertura del `Alert` y el contenido, y nada prueba que el toast dispare en runtime. Es el techo de una suite offline sin DOM.
- El limpiador de comentarios por `//` es un **riesgo latente** para futuras cadenas que contengan `//`.
- Runtime no ejecutado: la rama sin-sede y el toast de exito se verificaron estaticamente; el build no renderiza esa ruta dinamica.

## Estado
- 2026-10-01: creado. Autorizado por el usuario.
- 2026-10-01: WU-A en `bf74ca5` y pusheado. WU-B en `e9e51d0` (modulo `services`), elegido por evidencia: `cash.spec.ts` es **el unico** spec acoplado al mecanismo (5 aserciones sobre `p[role="status"]`), asi que caja queda descalificada; `services` no aparece en ningun spec.
- 2026-10-01: tanda 2 de WU-C en `ea759b2` (alerts), `4dc8d2b` (vales) y `ac05651` (nomina + el test de la tanda). Suite **466 → 501**.
- 2026-10-01: el writer de la tanda 2 reporto honestamente dos consecuencias de ARIA. Una se acepta (tres avisos bloqueantes pasan de cortes a asertivo por la politica del primitivo). La otra **NO se acepta como vino** y se refina en la tanda 3: dos avisos de rango de nomina **derivados en vivo** mientras se escriben las fechas ganaron un anuncio asertivo donde antes no habia ninguno. Interrumpir en un calculo en vivo es el anti-patron de sobre-anuncio; corresponden `role="status"` explicitos sobre la presentacion de `Alert`, usando la prop `role` que el primitivo ya expone. **No se toca `alert.tsx`** para esto: cambiarlo invalidaria su verificacion.
- 2026-10-01: se ejercita criterio en vez de ritual: la tanda 2 **no** paso por un verificador dedicado. UI pura, sin datos ni autorizacion; patron ya verificado dos veces; 35 aserciones nuevas con controles negativos; y el riesgo real -- que el split de la union `message` dejara algun camino sin salida -- lo revise leyendo el diff, donde cada `setMessage` previo tiene su contraparte. El gate de build si se corrio.
- 2026-10-01: la tanda 2 encontro una **cita obsoleta** en `app/tests/design-tokens.test.ts:211-212`, que afirmaba que el par de tokens de warning tenia consumidores reales en `payroll-client.tsx:1142` y `vouchers-client.tsx:346,351`. Esas clases ya no viven ahi. Se corrige en la tanda 3, sin tocar ninguna asercion de ese archivo.
