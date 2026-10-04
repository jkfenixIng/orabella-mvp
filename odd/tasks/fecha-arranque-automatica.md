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

Pendiente de la ejecución.

## Progress

| Unidad | Commit |
| --- | --- |
| U9 · U10 · U11 · U12 · U13 · U14 | — |
## Preguntas que la ejecución tiene que responder, no inventar

1. **¿Hay puerta de reparación de la fecha declarada?** Si el admin declara mal la fecha, la
   única vía de arreglo sería mientras el período es **borrador**. Hay que derivar del código si
   esa puerta existe (`payroll_correct_period_atomic` y el candado de edición) y, si no existe,
   **declararlo como límite** en lugar de inventar una. La alternativa —no poder corregir nunca—
   es aceptable porque la fecha se deriva de un período y el período es auditable.
2. **¿Qué pasa con la auditoría de la escritura que se retira?** `platform.payroll_start_date_set`
   deja de tener emisor. Se retira con la acción, o se conserva como acción histórica: hay que
   derivar si `AUDIT_ACTIONS` es un catálogo cerrado o un mapa libre.
3. **¿La fecha declarada puede ser el día de hoy?** Deriva del código si un ciclo sin cerrar puede
   ser la primera liquidación; hoy el detector solo camina sobre ciclos **cerrados**.

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
