# La fecha de arranque de la nómina nace de la primera liquidación

## Objective

Que la fecha de inicio de la nómina **deje de ser una configuración de un solo uso** que
alguien fija en `/plataforma`, y pase a ser **un hecho de la primera liquidación**: al abrir
el primer período el sistema pregunta desde cuándo se opera, el primer ciclo se **recorta** a
esa fecha (prorrata de ciclo parcial), y de ahí en adelante **nadie vuelve a preguntar nada**
porque el piso se deriva de los períodos que existen.

Decisión del dueño, 2026-10-04: *«la fecha de inicio puede ser automática y no por un
superadmin, y esa se genera con la primera liquidación, ya que así se sabe qué semana inició
operación el sistema sin depender de una configuración que solo se tocará una vez»*.

## Problem

Hoy el piso de la historia de nómina vive en `sedes.payroll_start_date` (migración 068, F10) y
lo escribe **una sola** superficie: `setPlatformPayrollStartDate`, el único formulario de
`/plataforma` (`PlataformaPayrollStartDateForm`).

Dos consecuencias, las dos vistas en la prueba de humo:

1. **El descubrimiento depende de la configuración.** `pendingPayrollSettlements`
   (`src/features/payroll/schemas.ts:1331`) devuelve `[]` cuando no hay piso, y ese detector es
   justamente el que **ofrece** el ciclo a liquidar. Sin fecha y sin períodos no hay nada que
   ofrecer: el dueño abrió «Abrir período» y no le ofrecía ningún ciclo. Es una dependencia
   circular: el mecanismo que sirve para liquidar la primera vez exige un dato que la primera
   liquidación debería producir.
2. **Una configuración que se toca una vez y hay que recordar.** Y que además está detrás de
   una capa (rol `superadmin` + `/plataforma`) que no tiene ninguna otra función de escritura.

## Design

**El piso pasa a ser un hecho derivado: `min(payroll_periods.start_date)`.** No es una regla
nueva — es la **regla 4 por evidencia que el código ya implementa**
(`schemas.ts:1331`: `floor = declaredStart ?? historyStart`, con `historyStart` el período más
antiguo). Lo que cambia es que deja de haber un `declaredStart` que compita con ella.

**El primer período ES la declaración.** Al abrir la primera liquidación —cuando no hay ningún
período— el formulario pide la fecha desde la que se opera. Es el mismo dato que hoy se fija en
`/plataforma`, pero dicho en el lugar donde se usa: el recorte del primer ciclo y el pago de su
prorrata (F5, `cycleProrationFactor`) son exactamente lo que esa fecha significa.

**Después del primer período no se pregunta más**, y no porque se guarde en otro lado: el piso
sale de `min(start_date)` de los períodos. Un período nuevo no puede empezar antes de ese piso,
y toda cadencia que todavía no liquidó se recorta al piso igual que hoy se recorta a la fecha
declarada.

### El reparto de responsabilidades que resulta

- `pendingPayrollSettlements`: **sin piso, ofrece los últimos ciclos cerrados** (el tope ya es
  `PENDING_SETTLEMENT_LIMIT = 3` por cadencia) en lugar de devolver `[]`. Eso rompe la
  circularidad: hay de dónde elegir el primer período.
- `openPayrollPeriod`: cuando **no hay ningún período**, acepta la fecha declarada y recorta el
  primer ciclo a ella; cuando ya hay períodos, el piso se deriva y la fecha declarada no se
  acepta (nadie la manda).
- `getPayrollStartDate(sedeId)` deja de leer la columna y pasa a derivarse de los períodos. La
  columna `sedes.payroll_start_date` **queda sin uso** pero **no se borra**: borrarla obliga a
  regenerar el archivo único de esquema y a resetear las dos bases, y eso no lo vale hoy. Se
  declara como deuda.
- `/plataforma` **se retira, no se deja en solo lectura.** Decisión del dueño, 2026-10-04:
  *«del 1 si no hace nada eliminarlo»*. Y no le queda nada: la fecha era su única escritura.
  Se retiran la pantalla, el servicio de plataforma, su acción, su acción de auditoría, el
  guardián `requirePlatformAdmin`, la entrada en el menú y el script de aprovisionamiento de la
  cuenta. **Qué queda en la base: el rol `superadmin` y su fila**, que se declaran como deuda —
  igual que la columna de la fecha— porque borrarlos obliga a regenerar el archivo único de
  esquema y a resetear las dos bases otra vez. Es la misma decisión de costo que la columna, y
  se paga junta en el próximo reset si el dueño lo pide.
- **Y con eso desaparece el pendiente de crear la cuenta `superadmin`**: si no hay superficie que
  la exija, no hay cuenta que crear. Ese ítem muere con esta unidad.

## Scope

Nómina (las funciones puras, el servicio, la acción y el diálogo) y la **retirada completa de la
capa de plataforma**, cuya única función era escribir esa fecha. **Nada de esquema, nada de
datos, nada de PRODUCCIÓN**: el rol `superadmin` y su fila quedan en la base declarados como
deuda, porque borrarlos hoy obliga a regenerar el archivo único y resetear las dos bases.

## Tasks

- [ ] **U9** — Las funciones puras: `pendingPayrollSettlements` sin piso ofrece los últimos
      ciclos cerrados por cadencia; el rango de apertura acepta la fecha declarada en la primera
      liquidación y la valida (dentro del ciclo elegido, no futura).
- [ ] **U10** — El servicio: el piso se deriva de los períodos; `openPayrollPeriod` acepta la
      fecha declarada solo cuando no hay ningún período; `getPayrollStartDate` deja de leer la
      columna.
- [ ] **U11** — La UI: el diálogo pide la fecha en la primera liquidación y muestra el rango
      recortado con su prorrata; sin períodos y sin fecha ya no hay un vacío que mienta.
- [ ] **U12** — Retirar la capa de plataforma: la pantalla `/plataforma`, `src/features/platform/`,
      su acción, su acción de auditoría, `requirePlatformAdmin`, la entrada del menú y
      `scripts/create-superadmin.ts`, con sus tests. **Y la tarjeta de la home que enlaza a esa
      pantalla** (`app/app/page.tsx:58`): es la que todavía dice «la sede» mientras la barra
      lateral dice «La instalación» — la inconsistencia que dejó el barrido de copia, y que se
      resuelve retirando la tarjeta junto con la pantalla, no cambiándole la palabra. Declarar
      como deuda el rol `superadmin` y su fila en la base, sin tocarlos.
- [ ] **U13** — Gate completo, commits por unidad y push.
- [ ] **U14** — Retirar del seed de humo la sentencia que fija `sedes.payroll_start_date`, que
      deja de existir como configuración.
- [ ] **U15** — El barrido de la copia restante que nombra la sede, que corre **después** de esta
      unidad porque los mensajes de nómina son de acá: ver `copia-sede-inventario.md`.

## Checks

- Sin períodos, el diálogo ofrece ciclos y la primera liquidación se puede abrir declarando la
  fecha desde la que se opera.
- El primer ciclo se recorta a la fecha declarada y su prorrata es la de F5.
- Con un período ya creado, la fecha no se vuelve a pedir y el rango se recorta al piso derivado.
- Un período nuevo no puede empezar antes del piso derivado.
- `/plataforma` ya no existe: ninguna ruta, ninguna acción, ninguna entrada de menú, y el rol
  `superadmin` sin guardián que lo exija. La fecha derivada se ve **en nómina**, que es donde se
  usa — no en otra pantalla a la que el admin que la lee no puede entrar.
- `npm run typecheck`, la suite completa y `npx eslint` en verde.

## Verification evidence

**Test-first, con el rojo observado antes de tocar el código**: `npx vitest run tests/payroll.test.ts`
dio **31 fallas sobre 487 pasando** (13 de U9, 12 de U10, 6 de U11) — «sin períodos no hay piso:
oofrece los últimos ciclos cerrados», «sin períodos y sin fecha declarada NO hay primer período: el
piso nace mudo», «el piso se DERIVA de los períodos: la columna de la 068 ya no se lee», «el PRIMER
período se abre RECORTADO a la fecha declarada», «la fecha declarada sólo se acepta en la PRIMERA
liquidación». Después del cambio: **496 de 496** en el archivo.

**El cambio destapó cinco pruebas que ya existían** y que el nuevo flujo dejó al descubierto
(F7 persistencia de rango, PR1 «compartir un día», la carrera 23P01, la lectura recortada y la vista
F9): se repuntaron con la fecha declarada del primer período o con un período ancla, **ninguna se
borró**.

| Comando | Resultado real |
| --- | --- |
| `npx vitest run tests/payroll.test.ts` | **496 passed / 496** (antes 487) |
| `npm test` | **1978 passed** en 37 archivos (antes 1969; **+9**, ninguna eliminada) |
| `npm run typecheck` | sin salida |
| `npx eslint` (6 archivos tocados) | exit 0, 0 problemas |

**Verificación independiente: CONFIRMADA, y el riesgo se revisó aserción por aserción.** El temor de
una unidad así no es que los tests pasen: es que una de las 31 aserciones repuntadas se haya
**aflojado** para que pasaran. El verificador comparó los nombres de todos los `it()` entre `HEAD` y el
árbol de trabajo: 19 con sucesor semántico claro, 11 nuevas, **ninguna borrada**, y **ningún test
pasando por una razón distinta**. La única relajación real es la que el cambio exige —el diálogo *ahora
sí* tiene un campo de fecha, así que la guarda que exigía «ningún input de fecha» pasó a exigir que ese
input sea **el declarado y acotado al ciclo**— y está compensada con aserciones positivas más fuertes.
Y encontró algo que vale: el «CONTROL NEGATIVO» viejo era **una tautología** —afirmaba propiedades de
un literal definido en el propio test, sin tocar el código—, así que se retiró y se reemplazó por
aserciones reales (que el diálogo no nombre `/plataforma`).

Los cinco comportamientos se confirmaron leyendo el código y corriendo los tests, no la descripción:
el aviso sin piso ofrece los últimos ciclos por cadencia (tope 3); la fecha es obligatoria sin períodos
**y por ninguna vía se puede crear el primer período sin ella** (la acción y la ruta REST desembocan en
la misma validación); el recorte y la prorrata son los de F5 sobre el rango **almacenado**; con
períodos el piso es el mínimo y la fecha declarada se rechaza; y un período nuevo no puede empezar
antes del piso. Las siete afirmaciones del diseño se verificaron una por una (seis confirmadas, una
parcial: ver el punto 1 de abajo). El contrato de la columna también: **fuera de
`src/features/platform/**` no queda ni una lectura ni una escritura de `sedes.payroll_start_date`**. Y
el gate se reprodujo exacto: 496 en nómina, 1978 en 37 archivos, typecheck y eslint limpios.

### Follow-ups que trajo la verificación

1. **`getPayrollStartDateAction` es código muerto**: no la consume nada de producción, sólo un test la
   llama. U12 —que retira la capa de plataforma— es su lugar.
2. **Mensaje duplicado en el cliente** (`payroll-client.tsx:1534`): la guarda en vivo
   `isRangeBeforePayrollStart` repite el texto del rechazo en vez de usar
   `openPayrollRejectionMessage`. **Hoy es inalcanzable** (el validador rechazó antes), pero es una
   segunda copia que puede divergir. Es lo que el writer dio por centralizado y **no lo estaba del
   todo**: la única afirmación que la verificación dejó en parcial.
3. **La etiqueta «días del ciclo» es imprecisa para quincenal y mensual**: la prorrata usa el ciclo
   **comercial** (7/15/30) mientras el ciclo cerrado es de **calendario** (7/14/28). Es comportamiento
   preexistente de F5, no introducido acá, pero el texto queda flojo.
4. **Inventario incompleto de la copia del flujo de nómina**: quedan **8** cadenas «de esta sede»
   (`service.ts:780,798,824,834,2398,2568,3654` y `payroll-client.tsx:2312`). Fuera del alcance de esta
   unidad por decisión, pero **tienen que estar en la lista de U15**.
5. **Documentación que quedó vieja**: `admin/service.ts:694,717` y `payroll/README.md:638` siguen
   citando la firma vieja `getPayrollStartDate(sedeId)`.
6. **`openPayrollPeriod` conserva `sedeId`** sólo porque la ruta REST lo pasa; cuando esa superficie se
   toque, el parámetro se cae.
7. **Un desacuerdo preexistente** entre el aviso y el diálogo en el caso `not-first-cycle` con un tope
   elevado: el aviso ofrece un ciclo que contiene el piso para una cadencia que ya tiene períodos y el
   diálogo lo rechaza. No lo introdujo este cambio, pero está medido.

**Lo que esta unidad NO puede verificar**, y por qué: el recorrido real —abrir el primer período
desde el diálogo, ver el recorte y la prorrata— necesita base y navegador. Va en la pasada manual del
dueño sobre la base sembrada, que es justamente el flujo nuevo.

### Dónde el diseño del documento no sobrevivió al código

1. **La prop de servidor se quedaba vieja**: `initialPayrollStartDate` venía congelada en `useState` y
   en cuanto se abre el primer período —lo que esta unidad cambia— quedaba obsoleta para el resto de
   la sesión. El cliente deriva el piso de `payrollHistoryFloor(periods)`, la misma función pura del
   servicio, y la prop desaparece.
2. **`sedeId` dejó de acotar algo**: `getPayrollStartDate()` y `listPayrollOverview()` pierden el
   parámetro. `openPayrollPeriod` **conserva** `sedeId` porque la ruta `app/api/v1/payroll-periods/route.ts`
   la llama y esa superficie no estaba permitida en esta unidad: queda documentado en su docblock.
3. **La fecha declarada pasó a ser OBLIGATORIA sin períodos.** El documento decía «acepta»; sin
   obligatoriedad el piso puede nacer mudo y el diálogo vacío del dueño **vuelve con otra forma**.
4. **«Dentro del ciclo elegido» tiene un techo que el documento no decía**: como el aviso ofrece 3
   ciclos cerrados por cadencia, un negocio que opere desde hace más sólo puede declarar un día del
   ciclo que liquida. Es coherente con el recorte y es un **límite declarado**, no inventado.
5. **Sin piso, el recorrido necesitaba un fin**: el bucle no tenía cota inferior. Se derivó del propio
   tope (sin piso son exactamente `limit` ciclos hacia atrás), lo que además evita un recorrido sin fin.
6. **Los rechazos se centralizaron** en `openPayrollRejectionMessage` (`schemas.ts`): el servicio y el
   diálogo dicen lo mismo de la misma regla, como es la convención del módulo.
7. **El aviso sigue recortando al piso** cuando el piso cae dentro de un ciclo (comportamiento F10
   preexistente, ahora con piso derivado) para que la lista diga lo que se va a abrir.

## Progress

| Unidad | Commit |
| --- | --- |
| U9 · U10 · U11 — el piso derivado y la primera liquidación | `09158f0` |
| U12 — retirar la capa de plataforma | pendiente |
| U14 — sacar del seed la sentencia de la fecha | pendiente |
| U15 — el barrido de la copia de nómina | pendiente |
## Las tres preguntas, respondidas por la ejecución

1. **¿Hay puerta de reparación de la fecha declarada? — NO, y queda declarado como límite.** Derivado
del código: `assertCorrectablePeriod` (`schemas.ts:647`) sólo corrige un período **cerrado**, y
`payroll_correct_period_atomic` (`service.ts:3089`) escribe la cabecera y las filas de la corrección
pero **nunca** `payroll_periods.start_date`; el único `UPDATE` de esa tabla en el módulo es
`status: "cerrado"` (`service.ts:2694`). La única puerta real es `assertDeletablePeriod`
(`service.ts:2781`, sólo borrador) → `payroll_delete_period_atomic` (`service.ts:2837`), auditado con
`PAYROLL_DELETED` incluyendo `start_date` y `end_date` (`service.ts:2868`). O sea: **una fecha mal
declarada se repara borrando el borrador y reabriéndolo** (y eso queda auditado); cerrado el período,
la fecha es historia y no se corrige. Se acepta porque el período es auditable.
2. **¿Qué pasa con la auditoría de la escritura que se retira? — `AUDIT_ACTIONS` es un catálogo
cerrado, y hay precedente exacto de retiro.** Es un `as const` (`audit.ts:31`), y `audit.ts:91-95`
documenta que `platform.sede_created` y `platform.sede_roles_set` **se retiraron del vocabulario**
cuando ya no había operación que auditar, conservando las filas históricas tal cual.
`platform.payroll_start_date_set` vive en `audit.ts:84-90`. ⇒ **U12 la retira con ese mismo
precedente**: se retira la acción, se conserva el comentario, **nunca las filas**.
3. **¿La fecha declarada puede ser el día de hoy? — No, porque un ciclo sin cerrar no puede ser la
primera liquidación.** El detector sólo camina ciclos **cerrados** (regla 2 en `schemas.ts:1432` con
`lastCompletedCycleEndDate`, `schemas.ts:982`: «el sábado **anterior** a la referencia»), así que el
ciclo que contiene hoy nunca llega al diálogo. Quedó cerrado por partida doble: el campo está acotado
(`max` = mín(ciclo, hoy)) y el validador rechaza `declared-in-the-future` (`schemas.ts:1273`). La
regla es «no futura», no «de ayer»: el día de hoy **sí** se acepta si el ciclo lo contiene, lo que por
esta misma respuesta no ocurre en el camino real.

## Dos restricciones que trajo la verificación, y que esta unidad hereda

Las encontró el verificador independiente en la unidad vecina (`smoke-test-defectos-1.md`) y son
**de esta** unidad, no de aquella:

1. **Dos mensajes del flujo de nómina siguen diciendo `la nómina de esta sede`**:
   `payroll-client.tsx:1525` (dentro de `handleOpen`) y `:2028` (el texto del primer ciclo
   recortado, que se muestra en el mismo diálogo). La guarda de la unidad vecina pasó porque
   buscaba la frase exacta `en esta sede`, pero estos dos sobreviven. **Son exactamente los
   mensajes que esta unidad reescribe** —el rango recortado y su prorrata—, así que se van con
   U11 y no con un barrido de copia aparte.
2. **El mensaje no puede mandar al admin a una pantalla que no puede abrir.** La copia que dejó
   la unidad vecina dice «se configura en /plataforma», y `/plataforma` es
   `requirePlatformAdmin` (solo `superadmin`) mientras el diálogo lo ve el admin de la
   instalación: la ubicación es cierta pero **no es accionable por quien la lee**. Es, de hecho,
   el mejor argumento a favor de esta unidad: en cuanto la primera liquidación declare la fecha,
   el mensaje deja de mandar a nadie a otra pantalla. La copia nueva **no** debe nombrar
   `/plataforma` ni ningún otro lugar fuera de este diálogo.

## Route declaration

Cambio de regla de negocio **decidido por el dueño** el 2026-10-04 (opción B de las dos
propuestas). No toca esquema, no toca datos de ninguna base, y no borra la columna.
