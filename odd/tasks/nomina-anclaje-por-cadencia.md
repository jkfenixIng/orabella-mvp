# El anclaje por cadencia: hasta cuándo se pagó cada grupo

## Objective

Que la nómina sepa, **por cadencia**, hasta qué día se pagaron los sueldos de ese grupo —antes y
después de que el sistema existiera— para dos cosas concretas:

1. que la primera liquidación **no vuelva a pagar días ya pagados**, y
2. que el aviso de ciclos pendientes **deje de pedir ciclos ya cubiertos**.

## Por qué este documento existe recién ahora (2026-10-06)

No es una unidad nueva: es una unidad **perdida**. El registro:

| Evidencia | Qué dice |
| --- | --- |
| Memoria `orabella/anclaje-cadencia-cobertura` (2026-10-05) | Las **cuatro decisiones del dueño**, con su frase textual: «¿hasta qué día se pagaron los sueldos de este grupo?» |
| `odd/tasks/auditoria-responsive.md:491` | «Su plan — *anclaje por cadencia*, cada grupo con su propia línea de tiempo — está en `odd/tasks/nomina-anclaje-por-cadencia.md`, que no es de esta unidad» |
| `git log --all --diff-filter=AD -- '*anclaje*'` | **Vacío: el archivo nunca se commiteó.** La referencia entró en `5756c28` |
| `odd/tasks/nomina-liquidador-usable.md:110-112` | El deferimiento: «…sólo serviría para declarar historia anterior al sistema, **que el dueño no pidió**» |

**Lo primero que se perdió fue este documento.** Después, el deferimiento se apoyó en una premisa que
el propio registro desmiente: la decisión 2 del dueño es *exactamente* declarar la historia anterior
al sistema. El dueño reclamó el 2026-10-06 («si es el primer periodo saber si antes de la
implementación del sistema ya se pagó mensualidad y quincenas, y no veo esos requerimientos hechos»)
y eligió reconstruir la unidad en lugar de sólo documentarla.

**Límite declarado de este documento**: el dueño también afirmó que había pedido que «la primera
fecha se calcule a partir de la primera factura». Se buscó en el PRD, en `odd/tasks/**` y en toda la
memoria: **no hay rastro de ese pedido**. Lo que sí está, como cita suya del 2026-10-04 en
`fecha-arranque-automatica.md`, es «esa **se genera con la primera liquidación**». Entre las tres
opciones que se le presentaron el 2026-10-06 eligió **el anclaje**, no el arranque derivado de la
factura. Si lo quiere, es otra unidad.

## Las cuatro decisiones del dueño (2026-10-05, textuales donde importa)

1. **El anclaje se ajusta al sábado.** La grilla NO se mueve: sigue domingo→sábado. Si declara una
   fecha que no cae en sábado, el sistema la corre **hacia adelante** (`saturdayOnOrAfter`): un
   anclaje «pagado hasta X» absorbe X+1..sábado. Razón: **el riesgo no es simétrico** — pagar dos
   veces los mismos días es el error grave; declarar de más se corrige en el ciclo siguiente.
   Consecuencia asumida: los días entre la fecha declarada y el sábado siguiente quedan declarados
   pagados y **hay que MOSTRARLO en pantalla**, no esconderlo.
2. **Declara COBERTURA, no la fecha de pago.** La pregunta es «¿hasta qué día se pagaron los sueldos
   de este grupo?», no «¿cuándo hiciste el pago?». Lo que el sistema necesita es el último día
   consumido y pagado. Preguntar mal esto hace que la primera liquidación vuelva a pagar días ya
   pagados.
3. **Se declara una sola vez, sólo por cadencia con gente activa.** Sin empleados activos de esa
   cadencia no hay nada que liquidar y la pregunta es ruido. Una cadencia **sin** anclaje declarado
   usa el **piso global** como ancla (fallback), y el piso global —`min(payroll_periods.start_date)`,
   `payrollHistoryFloor`— **NO desaparece**.
4. **No contradice F10 (2026-10-04): lo generaliza.** F10 hizo del arranque un hecho único derivado;
   esto lo hace **por cadencia**.

## El problema, medido (2026-10-06, PRUEBAS)

Con 0 períodos no hay piso, así que `pendingPayrollSettlements` (`schemas.ts:1604`) recorre hacia
atrás con su único tope —`PENDING_SETTLEMENT_LIMIT = 3` por cadencia— y reporta **9 ciclos**, el más
viejo `mensual 12-jul → 8-ago`: 3 × 28 días desde el último sábado cerrado. La instalación, sin
embargo, **no tiene un solo registro antes del 28-sep**. El módulo no puede distinguir «no se pagó»
de «se pagó antes de que existiera el sistema», y hoy la única forma de silenciarlo es la
declaración de la primera liquidación, que fija **un solo piso global** y por lo tanto no puede decir
«el mensual se pagó hasta el 30-sep pero el quincenal sólo hasta el 15-sep».

## Diseño

### Dónde se guarda (sin cambio de esquema)

`system_settings`, **una fila por cadencia**: claves `payroll_anchor_semanal`,
`payroll_anchor_quincenal`, `payroll_anchor_mensual`, valor `{"paid_through": "YYYY-MM-DD"}`.

Precedente medido: esa tabla ya es «una fila por ajuste» —el contador de facturas
(`invoice_sequence`) y los topes de vales viven ahí desde la 072— y tiene camino de escritura
auditada (`service.ts:3384`, `entity: "system_settings"`).

**Ventaja de entrega, y es la razón de elegirla: NO hay migración.** Nada que agregar a
`schema-history/`, nada que regenerar en `001_orabella_schema.sql`, nada que resetear en las bases.
Una tabla nueva costaría las tres cosas.

### Las reglas puras (una sola definición cada una)

- `cadenceAnchorFromDeclaration({ paidThrough, referenceDate? })` → `{ ok: true; anchor;
  absorbedFrom; absorbedDays }` o `{ ok: false; reason: "anchor-not-a-day" | "anchor-in-the-future" }`.
  Ajusta al sábado **hacia adelante** (decisión 1) y devuelve **los días absorbidos como dato**, no
  como frase: son los que la pantalla tiene que mostrar. La guarda del futuro es sobre el día
  **declarado**, no sobre el ancla ajustada — absorber hasta el sábado siguiente es la semántica
  pedida, no un error. `absorbedFrom` es el día siguiente al declarado, y con una declaración en
  sábado vale 0 (`absorbedDays`), porque no hay nada que absorber.
- `resolveCadenceAnchor({ declared?, globalFloor? })` → la precedencia, en este orden:
  1. anclaje declarado (ya ajustado al sábado);
  2. si no hay, el **piso global** (decisión 3: es el comportamiento de hoy, intacto);
  3. si no hay ninguno, `null`.
- `isCycleCoveredByAnchor({ endDate, anchor? })` → verdadero cuando el **último día** del ciclo es
  ≤ el anclaje. Un ciclo cubierto no se reporta ni se abre.
- `cadencePayableFrom(anchor)` → el primer día pagable de esa cadencia: `anclaje + 1 día`,
  que en la grilla domingo→sábado es el domingo del ciclo siguiente.

**PREMISA FALSA, REFUTADA EL 2026-10-06 — leer esto antes de tocar T2/T3.** Escribí acá que «el
ancla siempre cae en sábado y los ciclos también cierran en sábado, así que «cubierto» es exacto y
no hay caso intermedio». **Es falso para `mensual`**, y lo refutó quien fue a implementarlo: los
cierres mensuales son **cada 4 sábados** (03-oct, 05-sep, 08-ago, 11-jul), así que un ancla que ajusta
a un sábado intermedio cae **dentro** de un ciclo mensual. Caso real medido: un ancla en **26-sep**
(sábado) cae dentro del ciclo mensual **06-sep → 03-oct**, cuyos días 06..26 quedan pagados y los
días 27-sep..03-oct **no**.

De ahí salen **dos conceptos distintos que no se pueden confundir** —confundirlos rompe un test que
ya existe (`tests/payroll.test.ts:12401`)—:

| Concepto | Qué significa | Qué hace |
| --- | --- | --- |
| **Piso global** (`payrollHistoryFloor`) | «la historia de la nómina **empieza** el día F» | Corta el recorrido (un ciclo con `fin < F` no se reporta) y **sube** el inicio del rango. **NO** marca cobertura: un ciclo que termina exactamente en F sigue siendo el primer ciclo, recortado a `F→F` |
| **Anclaje declarado** | «los días hasta A están **pagados**» | Un ciclo con `fin ≤ A` está **cubierto**: no se reporta ni se abre. Un ciclo que **contiene** A se reporta y se abre **recortado a `A+1`**, y sus días posteriores siguen pagándose |

**Decisión derivada (2026-10-06, del orquestador y no del dueño)**: el recorte a `A+1` es la **única**
lectura compatible con las decisiones 1 y 2. La decisión 1 dice que el anclaje absorbe «X+1..sábado»,
no «hasta el cierre del ciclo»; y la decisión 2 dice que declara días **pagados**, así que lo que no
está pagado tiene que seguir siendo pagable. Descartar el ciclo mensual entero declararía pagados 7
días que nadie declaró. La alternativa —tratar como cubierto todo ciclo que contenga el ancla— es un
cambio de una línea, pero es **una decisión de plata distinta** y la tiene que tomar el dueño.

**Notas de as-built (2026-10-06)**: las firmas de arriba son las **implementadas**, no las que este
documento escribió primero (`resolveCadenceAnchor` no recibe `frequency` porque la precedencia no lo
necesita, y `isCycleCoveredByAnchor` recibe el fin del ciclo, no el ciclo entero). El módulo **no le
asigna número de feature**: es una generalización de F10, no un requisito nuevo del PRD, y el número
no está en ningún registro.

### Efectos

| Superficie | Qué cambia |
| --- | --- |
| `pendingPayrollSettlements` | No reporta ciclos cubiertos por el anclaje **de su cadencia** |
| `resolveOpenPayrollRange` / `openPayrollPeriod` | Abrir un ciclo cubierto se rechaza con un motivo **nuevo** y su mensaje, en la misma voz única que ya usa `openPayrollRejectionMessage` |
| El resumen y el aviso | Dicen, por cadencia, hasta qué día está declarada cubierta |
| La pantalla del anclaje | Muestra **los días absorbidos** por el ajuste al sábado (decisión 1) |

### Dónde se declara

Un campo **por cadencia con gente activa** (decisión 3), visible **mientras esa cadencia no tenga
anclaje declarado**. Con el anclaje puesto, se muestra en sólo lectura.

**Ventana de reparación — decisión derivada, a confirmar por el dueño**: el anclaje es editable
mientras **esa cadencia no tenga ningún período**; con el primer período de esa cadencia queda de
sólo lectura. Motivo: un error de tipeo en una fecha que declara días pagados no puede ser
irreversible, y la ventana no contradice «se declara una sola vez» —la segunda vez ya hay períodos
que son la evidencia—. Es el mismo límite que F10 dejó declarado para la fecha de arranque.

### Auditoría

Acción nueva `payroll.cadence_anchor_set` en el vocabulario cerrado `AUDIT_ACTIONS`, con el mismo
argumento que ya justifica `VOUCHER_LIMITS_SET`: **decide plata** (declara días como ya pagados) y
tiene que quedar escrito quién, qué cadencia, la fecha declarada y la efectiva. **NO entra a ningún
catálogo de alertas**: es configuración, no un desvío que alguien deba autorizar o rechazar.

## Tareas (T1–T6)

- [ ] **T1** — Las reglas puras y sus tests **en rojo primero**: el ajuste al sábado hacia adelante
      con los días absorbidos, la precedencia declarado → piso global → `null`, el ciclo cubierto, y
      las guardas (fecha futura). Superficie: `src/features/payroll/schemas.ts`, `tests/payroll.test.ts`.
- [ ] **T2** — El aviso de pendientes honra el anclaje **por cadencia**, con el caso del dueño como
      test: `mensual 12-jul → 8-ago` deja de aparecer cuando el mensual está anclado. **La cobertura
      la dispara el anclaje DECLARADO, no el piso global**, y el ciclo a medias se reporta recortado
      a `ancla + 1` (ver la tabla de la sección de reglas). **No** se alimenta el piso como cobertura:
      el piso conserva su papel de hoy (corta el recorrido y sube el inicio) y el test `12401` tiene
      que seguir verde sin tocarlo.
- [ ] **T3** — La apertura honra el anclaje: el ciclo cubierto se rechaza con su motivo y su mensaje
      en una sola voz (servicio y pantalla dicen lo mismo), y el ciclo a medias se abre recortado a
      `ancla + 1` — **el mismo rango que reporta el aviso**, que es la invariante del módulo.
- [ ] **T4** — Lectura y escritura del anclaje en `system_settings` (upsert por `key`), auditada.
- [ ] **T5** — La pantalla: declarar una vez por cadencia con gente activa, el anclaje vigente en
      sólo lectura, y **los días absorbidos a la vista**.
- [ ] **T6** — Aplicarlo a PRUEBAS, medir por lectura, y verificación independiente.

## Fuera de alcance

- **El arranque derivado de la primera factura.** No fue lo elegido; ver el límite declarado arriba.
- **Mover la grilla fuera del sábado** (decisión 1: la grilla no se mueve).
- **Recalcular períodos cerrados** (`assertDraftPeriod`).
- El piso global no se toca: sigue siendo el fallback de una cadencia sin anclaje.

## Riesgos

- **El ajuste hacia adelante absorbe días.** Declarar el miércoles 30-sep marca pagados el 1, 2 y 3
  de octubre de ese grupo. Es la decisión tomada, con su razón (el riesgo no es simétrico), y se
  muestra en pantalla.
- **Un anclaje mal declarado hacia adelante esconde días impagos.** La ventana de reparación acota
  el daño pero no lo elimina. Es la semántica pedida: una declaración, no una evidencia.
- **El anclaje no valida contra la realidad.** Si se declara «pagado hasta X» sin haberlo pagado, el
  sistema no vuelve a ofrecer esos días.
