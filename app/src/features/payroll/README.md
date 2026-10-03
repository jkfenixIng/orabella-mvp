# Módulo `payroll` — T7 nómina y vales + cierre transversal (PAY-01…07, TRA-02…03)

Nómina mixta con cálculo desde facturación y vales con topes y aprobación.
Último módulo funcional del MVP: cierra la cadena empleado (T3) →
factura con empleado por línea (T5) → métodos de pago (T3/T6) → liquidación.

- Tablas (migración `007_payroll.sql`): `payroll_periods` (`sede_id`,
  `start_date`/`end_date` con `end_date >= start_date`, `status`
  borrador/cerrado default borrador, `created_by`, `closed_at` con CHECK
  cerrado-exige-cierre; índice único parcial
  `uq_payroll_draft_per_range` where borrador), `payroll_items`
  (`period_id` cascade, `employee_id`, `base_fixed`/`commissions`/`bonuses`
  default 0, `deductions_vales`/`other_discounts` default 0, `net_pay` con
  CHECK neto = base + comisiones + bonos − vales − otros con tolerancia de
  centavo, `detail_json` jsonb por factura/ítem, `adjustment_reason` text NULL
  —el motivo escrito del ajuste manual, migración
  `067_payroll_adjustment_reason.sql`; F8—; unique
  `period_id,employee_id`), `payroll_payments` (`payroll_item_id` cascade,
  `method_id` + snapshot `method_code`, `amount > 0`, `paid_at` default now,
  `paid_by`, `reference`; trigger `check_payroll_payments_cap`: la suma por
  ítem nunca excede el neto), `voucher_settings` (`sede_id` PK,
  `max_per_day`/`max_per_week >= 0`; desde la 072 sus cuatro ajustes viven en
  `system_settings` y esta tabla queda sin lectores a la espera del borrado —
  ver "Los ajustes de vales son ajustes de la INSTALACIÓN"), `voucher_requests` (`sede_id`,
  `employee_id`, `amount > 0`, `request_date` default current_date, `status`
  pendiente/aprobada/rechazada/descontada default pendiente, `approved_by`,
  `method_code` + `cash_shift_id` (migración 028: método arqueable y turno de
  caja que abrió el vale), `approval_code` (histórico, ya sin uso),
  `observation`; descontada y rechazada terminales).
- Vales reales y deuda del sobrante (migraciones `061_payroll_voucher_debt.sql`,
  `062_payroll_carry_apply.sql`, `064_payroll_partial_carry.sql` y
  `066_payroll_carry_delete_fks.sql`):
  `payroll_items.voucher_total` guarda el
  **total REAL** de vales del empleado en el rango del período, FUERA de la
  igualdad del neto; `deductions_vales` sigue siendo lo que se **aplicó**
  (topeado al bruto, con su signo). Cuando un vale supera lo ganado, el
  exceso (el recorte que el tope no pudo descontar) queda como **deuda** del
  empleado en `payroll_discount_carries` (por sede + empleado, con el período
  de ORIGEN y `applied_period_id` nulo mientras está pendiente). La deuda
  pendiente de períodos ANTERIORES se descuenta en el período siguiente
  DENTRO de `other_discounts` —así la igualdad del CHECK de `payroll_items`
  sigue vigente sin modificarla y el empleado lo ve como "otros descuentos"—
  y su trazabilidad vive en la tabla de deudas. El marcado
  (`applied_period_id`) ocurre en la MISMA transacción que el descuento
  (`payroll_apply_atomic`, `062`): un fallo no puede dejar el descuento
  escrito con la deuda todavía pendiente y aplicarla dos veces. La deuda se
  consume SOLO por lo que el tope **aplicó de verdad**: cuando `vales + deuda`
  supera el bruto, el sobrante de la deuda NO se perdona —el ítem lo lleva en
  `debt_remainder` y `payroll_apply_atomic` (`064`) lo re-registra como deuda
  **PENDIENTE** en la MISMA transacción, con este período como origen y
  `origin_kind = 'carry_remainder'`, para que la aplique un período POSTERIOR
  (nunca el actual: su origen no es anterior a sí mismo)—. Una deuda se
  aplica UNA vez; recalcular el mismo período no la duplica (guarda
  `NOT EXISTS` por origen + empleado + `origin_kind`) ni vuelve a marcar una
  ya consumida, y el ítem expone
  `voucher_total` y `pending_debt` (la deuda pendiente de ese período) para
  la UI.
- Servicio (`service.ts`): `openPayrollPeriod` (23505 del índice →
  `PERIOD_DRAFT_EXISTS`), `calculatePayroll` (fijo según `pay_type`
  fijo/mixto + comisiones desde `invoice_items` del rango por `employee_id`
  —regla de negocio: solo facturas `Pagada`; una `Emitida` no comisiona— con
  `detail_json` por factura/ítem; el fijo queda sin reporte; bonos/otros por
  ajustes; vales pendientes/aprobados del rango se descuentan y pasan a
  descontada, y los ya `descontada` del rango siguen contando al recalcular;
  recalcular reproduce el mismo neto),
  `payPayrollItem` (porciones con métodos activos, montos > 0; abonos
  parciales permitidos —40/40/20 en una o varias llamadas— y el acumulado
  nunca excede el neto), `closePayrollPeriod` (inmutable: `assertDraftPeriod`
  bloquea cálculo, pagos y cambios posteriores), `setVoucherLimits`
  (un `upsert` de las cuatro claves de `system_settings`, 072), `requestVoucher` (nuevo flujo: la CAJA con turno abierto
  abre el vale; exige turno abierto y dueño o admin; elige el método arqueable
  al crear; valida topes día/semana y días permitidos —dentro de rango se
  genera directo/aprobada, fuera de rango queda pendiente con
  `requires_approval` y alerta `voucher.requested`—),
  `approveVoucher` (solo pendiente; autorización con `approved_by` +
  observación, SIN código), `rejectVoucher` (solo pendiente, motivo
  obligatorio). Escritura: admin (pagos también caja);
  lectura: cualquier rol de la sede. Reutiliza `requireSedeRole`/
  `resolveSede`, `listPaymentMethods` + `getEmployee`/`listEmployees` (T3),
  `getOpenShiftWithOpener` (T6) para el turno de caja, `roundMoney`/
  `moneyEquals` (T5), `ok()`/`fail()`.
- API-first (`/api/v1`): `POST /payroll-periods` (+ `GET` lista),
  `GET /payroll-periods/:id` (periodo + ítems con pagado/saldo),
  `POST /payroll-periods/:id/calculate` (`{adjustments[]}` opcional),
  `POST /payroll-periods/:id/close`, `POST /payroll-items/:id/payments`,
  `GET/POST /vouchers` (solicitar devuelve `requires_approval`),
  `POST /vouchers/:id/approve`, `POST /vouchers/:id/reject`,
  `GET/POST /voucher-settings` (topes; extra fuera del listado mínimo para
  la UI).
- Fecha de inicio de la nómina (migración `068_payroll_start_date.sql`):
  `sedes.payroll_start_date date NULL` — la fecha desde la que la nómina OPERA
  en la sede. `NULL` = todavía no configurada (y el módulo se comporta como hoy).
  F10: ver "Fecha de inicio de la nómina de la sede".
- UI (`/payroll`, español): periodos (abrir, ver, calcular con ajustes
  bonos/otros por empleado y su motivo obligatorio —F8—, tabla
  fijo/comisiones/bonos/vales/otros/motivo/neto
  con pagado/saldo, detalle expandible por factura/ítem, pagar por
  porciones `método:monto`, cerrar; cerrado muestra inmutabilidad), vales
  (topes vigentes + guardar, caja abre con empleado/monto/método arqueable,
  aprobar o rechazar según rango).
- Tests (`tests/payroll.test.ts`): mixto 800000+150000+50000−100000−20000 =
  880000 reproducible, fijo sin comisiones, porcentual sin base, neto nunca
  negativo, `detail_json` ordenado por factura/ítem que suma comisiones,
  pago dividido exacto 40/40/20, `SUM_MISMATCH`/`OVERPAID`, cerrado
  inmutable (`PERIOD_CLOSED`), tope día/semana con aprobación obligatoria,
  semana desde el lunes, estado inicial directo/pendiente por rango,
  terminales sin doble descuento, el borrado de un borrador con historia de
  deuda (la producida cae con el borrador, la consumida vuelve a pendiente;
  migración 066), y texto de las migraciones 007/024/026/028/048/066.
- RLS: deny-by-default; políticas por sede endurecidas en T8
  (`008_hardening.sql`: `TODO(seguridad-T7)` cerrado, claim
  `app_metadata.sede_id`).
- Notas: el neto se acota a 0 si los descuentos superan el bruto (el CHECK
  exige `net_pay >= 0`); el total real de vales NO se pierde por ese recorte:
  vive en `voucher_total` y el sobrante se arrastra como deuda del empleado
  (ver arriba). T8: cálculo (`payroll.calculated`), cierre
  (`payroll.closed`) y aprobación de vales (`voucher.approved` con flag
  `over_tope`) auditados vía `writeAudit` (solo servidor).
- PRD: §5.6 PAY-01…04, §5.7 PAY-05…07, §9
  payroll_periods/items/payments + voucher_settings/requests, §10
  Nómina/vales, plan paso 6 (§12).

## El motivo del ajuste manual es obligatorio (F8, 067)

Decisión del dueño (2026-10-01): **TODO** ajuste manual lleva su motivo escrito,
siempre, no sólo en la primera liquidación. El admin carga bonos y otros
descuentos por empleado en el borrador; sin un motivo, una diferencia en la
liquidación sólo la podía explicar la memoria de quien la cargó.

### Dónde vive y por qué viaja con el monto

`payroll_items.adjustment_reason text NULL` (migración
`067_payroll_adjustment_reason.sql`, con su COMMENT). NULL es «sin ajuste
manual»: cuando `bonuses` y `other_discounts` son 0 no hay nada que explicar. La
columna vive en la MISMA fila que el monto que justifica y se escribe en la
MISMA sentencia (`payroll_apply_atomic`), cuya firma de cuatro parámetros NO
cambia: el motivo viaja dentro de cada ítem como `adjustment_reason`, igual que
`voucher_excess`. Es deliberado: si el monto y su explicación fueran dos
escrituras, un fallo entre las dos dejaría una diferencia sin rastro. El ajuste y
su motivo se confirman o se revierten JUNTOS.

### La regla

- Con `bonuses != 0` u `other_discounts != 0` el motivo es **obligatorio**.
- Sin ajuste no se pide, y un motivo suelto **se descarta** (nunca se persiste
  sin monto): la columna queda NULL. La invariante es «motivo presente ⇔ ajuste
  manual presente».
- La forma (no vacío después de recortar, ≤ 200 caracteres) se valida en el
  esquema del servicio (`employeeAdjustmentSchema`) y en la guarda 1.1 de
  `payroll_apply_atomic`; un motivo vacío o desmedido se rechaza con
  `PAYROLL_INVALID` en la base.
- La obligación se valida en `calculatePayroll` —el único camino que CARGA
  ajustes manuales— con un `VALIDATION` (400) que **nombra al empleado** y dice
  qué falta: una llamada directa al servicio (ruta REST, server action) no puede
  colar un ajuste sin motivo. La corrección de un período cerrado NO pasa por esa
  guarda a propósito: no crea ajustes, reproduce los que la liquidación firmada
  ya tenía (con su motivo) y no debe romperse con las liquidaciones anteriores a
  F8.
- La identidad de `payroll_items` no cambia: el motivo no entra en la igualdad
  del neto.

### En pantalla

En la tabla del borrador, cada fila gana un campo **Motivo del ajuste** junto a
Bonos y Otros (descuento); se anuncia como obligatorio (`aria-required` y el
marcador «Motivo (obligatorio)») cuando la fila lleva ajuste, y se valida al
recalcular reusando el canal de error que ya existe. En la tabla cerrada y en el
detalle, el motivo guardado se muestra tal cual, para que una liquidación firmada
pueda responder «por qué este empleado tiene este ajuste» sin depender de nadie.

### La nota de la primera liquidación (F5, corregida)

La nota del diálogo decía que la primera liquidación «suele ser un rango corto»;
eso dejó de ser cierto cuando los ciclos empezaron a embaldosar el calendario:
cada período NUEVO es un ciclo completo y la fracción del fijo es la entera. La
nota ahora dice eso, y que cualquier complemento se carga como ajuste **con su
motivo**.

## Borrado de un borrador con historia de deuda (066)

Un borrador se borra con `deletePayrollPeriod` → `payroll_delete_period_atomic`
(048): la reversión de los vales y el `DELETE` del período son UNA sola
transacción. Hasta la `065`, ese borrado moría con `INTERNAL: Error interno.`
cuando el período tenía historia de deuda. Las dos FK de
`payroll_discount_carries` a `payroll_periods` (`origin_period_id` y
`applied_period_id`) se declararon en la 061 SIN `ON DELETE` —eran las ÚNICAS
de la tabla que referencian el período y las únicas sin cláusula—, así que el
`DELETE` del paso 1.7 levantaba un `23503` que revertía la transacción entera y
`toRpcDeletePeriodError` no tenía (ni podía tener) una rama para él. Se
reproduce con UN solo vale mayor que el bruto del empleado en el período: el
sobrante crea la deuda y el borrador deja de poder borrarse.

La `066_payroll_carry_delete_fks.sql` re-declara las dos FK con la cláusula que
les faltaba, sin tocar la tabla ni migrar datos. La semántica de cada una en el
borrado:

- **Deuda PRODUCIDA por el borrador** (`origin_period_id`): `ON DELETE
  CASCADE`. La deuda se va CON el borrador, y es correcto: la misma transacción
  revierte los vales que la causaron, así que la deuda se queda sin causa.
  Conservarla sería una deuda sin vale que la explique. `origin_period_id` es
  `NOT NULL`, así que `SET NULL` no es una opción para él.
- **Deuda CONSUMIDA por el borrador** (`applied_period_id`): `ON DELETE SET
  NULL`. La deuda vuelve a **PENDIENTE**: borrar los ítems deshace la absorción,
  y el período de ORIGEN sigue existiendo, así que un ciclo POSTERIOR la vuelve
  a aplicar. No se pierde: se posterga. La columna es nullable (NULL =
  pendiente), que es justo el estado al que hay que volver.

El `CASCADE` y el `SET NULL` están acotados a las filas que referencian el
período borrado: la deuda de otros períodos queda intacta.

## Cadencia de pago y regla del mixto (F3)

Las migraciones `063_nomina_frecuencias.sql` (columnas) y `064` (deuda de
vales) ya están aplicadas. `employees.pay_frequency` y
`payroll_periods.frequency` son `text NULL` con catálogo cerrado
`semanal | quincenal | mensual`. **NULL no es un valor más: es la AUSENCIA de
cadencia** y conserva el comportamiento de hoy (el fijo se prorratea por los
días calendario del período con `prorateFixedSalary`). Mientras falte la
cadencia de cualquiera de los dos lados, ningún camino existente cambia.

### Fracción del fijo por cadencia

Cuando el período y el empleado TIENEN cadencia, la del PERÍODO decide quién
cobra el fijo y con qué fracción, sobre un **mes comercial de 30 días** (el mes
se cuenta como 4 semanas):

| Cadencia del período | Fracción | Fijo del período (ej. mensual 1.500.000) |
| -------------------- | -------- | ---------------------------------------- |
| `semanal`            | `1/4`    | 375.000                                  |
| `quincenal`          | `1/2`    | 750.000                                  |
| `mensual`            | `1`      | 1.500.000                                |

- **Coinciden**: el fijo es `mensual × fracción` sobre el ciclo completo; si el
  rango del período es MÁS CORTO que ese ciclo, la fracción se prorratea (F5,
  ver abajo).
- **Difieren**: el empleado queda **FUERA del período entero** (F4): no se le
  arma ítem, no se le liquidan comisiones y sus facturas del rango no entran a
  ninguna parte. Lo paga su propio ciclo y pagarlo en los dos lo pagaría dos
  veces; con un semanal y un mensual que se superponen a propósito, la misma
  factura podría liquidarse dos veces si solo se excluyera el fijo. El caso está
  en `resolveFixedSalaryForPeriod` como clasificación pura (`basis =
  "other-cadence"`), pero la exclusión real ocurre ANTES de calcular, en
  `computePayrollLines` (`periodExcludesEmployeeByCadence`).
- **Consecuencia aceptada por el dueño (2026-10-01)**: `1/4` por semana paga
  ≈ 13 sueldos al año (52,14 semanas), no 12. El mes comercial de 30 días es lo
  que produce esa cuenta; no se reabre la decisión.

### Prorrateo del ciclo parcial y primera nómina (F5)

La plataforma se entrega a mitad de semana, así que la primera liquidación cubre
solo unos pocos días (el caso real: 4). Con la fracción entera, un empleado
semanal cobraría un ciclo COMPLETO por 4 días: un sobrepago. Por eso, cuando las
dos cadencias coinciden y el rango del período es más corto que el ciclo natural
de la cadencia, la fracción se escala:

```
fijo = mensual × fracción × (días del período / días del ciclo)
```

Los días del ciclo salen del MISMO mes comercial de 30 días de la fracción:
semanal = 7, quincenal = 15, mensual = 30. El redondeo es UNO solo, a peso
entero (`roundMoney`), como todo el módulo.

| Cadencia   | Ciclo | Período de ejemplo | Fijo (mensual 1.500.000)         |
| ---------- | ----- | ------------------ | -------------------------------- |
| `semanal`  | 7     | 4 días             | `1.500.000 / 4 × 4/7 = 214.286`   |
| `quincenal`| 15    | 10 días            | `1.500.000 / 2 × 10/15 = 500.000` |
| `mensual`  | 30    | 20 días            | `1.500.000 × 20/30 = 1.000.000`   |

- **Ciclo completo sin cambios**: un rango de 7, 15 o 30 días paga `375.000`,
  `750.000` y `1.500.000` respectivamente; el prorrateo no toca el ciclo entero.
- **Tope del ciclo**: si el rango alcanza o pasa el ciclo, la fracción se topa
  en el ciclo completo (`1/4`, `1/2`, `1`) y NUNCA paga más de un ciclo. Un
  período de un mes natural (28…31 días) paga el ciclo entero, no `31/30` de la
  fracción. Para pagar dos ciclos harían falta dos períodos.
- **Sin cadencia**: si falta la del período o la del empleado, rige el
  prorrateo por días calendario de siempre (`prorateFixedSalary`), intacto; la
  exclusión por cadencia distinta (F4) y la regla del mixto tampoco cambian.
- **El complemento se carga con lo que YA existe**: si el negocio quiere pagar
  una diferencia, va en los ajustes por empleado del borrador (`bonuses` /
  `other_discounts`, PAY-02), y desde F8
  **cada ajuste manual exige su motivo escrito** (ver abajo). No hay campo de
  monto nuevo, columna ni migración adicionales, y la identidad de
  `payroll_items` no se mueve.
- **En pantalla**: al abrir el primer período de una sede (sin períodos previos),
  el diálogo "Abrir período" dice en texto plano que la primera liquidación es
  un **ciclo completo** —igual que las siguientes— y que cualquier complemento
  va en los ajustes por empleado del borrador, con su motivo.

Las funciones puras del prorrateo viven en `schemas.ts` (`PAY_CYCLE_DAYS`,
`cycleDaysForFrequency`, `periodRangeDays`, `cycleProrationFactor`) y
`resolveFixedSalaryForPeriod` las aplica.

### Regla del mixto

Un empleado `mixto` cobra, por su bloque fijo + porcentajes, **el MAYOR** entre
su básico del período y los porcentajes de SERVICIOS del período:

| Básico del período | Porcentajes de servicios | Bloque fijo + porcentajes |
| ------------------ | ------------------------ | ------------------------- |
| 300.000            | 400.000                  | 400.000                   |
| 300.000            | 200.000                  | 300.000                   |

- La comparación es **solo contra los porcentajes de servicios**. Las
  comisiones fijas por producto NO entran al máximo y se siguen sumando como
  hasta hoy (`básico 300.000`, `porcentajes 400.000`, `producto 50.000` →
  450.000).
- La regla se reparte sobre las columnas EXISTENTES, sin mover la identidad
  `neto = base_fixed + commissions + bonuses − deductions_vales − other_discounts`:
  - `base_fixed` sigue llevando el básico del período;
  - la parte porcentual de `commissions` pasa a `max(0, porcentajes − básico)`;
  - `max(básico, porcentajes)` = `base_fixed + la parte porcentual de
    commissions`.
- El porcentaje que el básico ABSORBE (`min(básico, porcentajes)`) se ve en el
  detalle como una **línea de ajuste** (`item_type = "ajuste_mixto"`, con su
  monto en negativo): así los porcentajes no desaparecen entre las columnas y la
  suma de `detail_json` vuelve a dar exactamente `commissions`. La línea no
  menciona ninguna factura, así que el candado de nómina cerrada no la confunde
  con una.
- `fijo` y `porcentaje` conservan sus reglas de siempre salvo la fracción del
  fijo de arriba.

Las funciones puras viven en `schemas.ts` (`fixedFractionForFrequency`,
`resolveFixedSalaryForPeriod`, `resolveMixedBlock`, `mixedAbsorbedDetailLine`) y
el cálculo de `computePayrollLines` (`service.ts`) las usa tal cual, tanto en el
borrador como en la corrección de un período cerrado.

## Cadencia del período, solape y exclusión (F4)

El diálogo de apertura de `/payroll` incluye la **cadencia del período**
(`Semanal (mensual / 4)`, `Quincenal (mensual / 2)`, `Mensual (mes completo)`).
Desde F7 la cadencia es OBLIGATORIA en un período nuevo: no hay opción "Sin
cadencia" y el rango sale del ciclo elegido (ver "Ciclo cerrado del período
(F7)"). El catálogo es el mismo `payFrequencySchema` (`semanal | quincenal |
mensual`) que valida la ficha del empleado; un cuarto valor se rechaza con
`VALIDATION`. `NULL` sigue existiendo SOLO como dato heredado y no se puede
pedir por la apertura.

### La guarda de solape, acotada por cadencia

La restricción `ex_payroll_periods_no_overlap` (063) es
`EXCLUDE USING gist (sede_id =, coalesce(frequency, '') =, daterange(...) &&)`.
`openPayrollPeriod` aplica la MISMA regla antes del INSERT: un período estorba
sólo si comparte días **y** cae en el mismo **cubo de cadencia**
(`periodCadenceBucket`, `coalesce(frequency, '')`). El NULL es el cubo vacío: dos
períodos sin cadencia siguen siendo mutuamente excluyentes (protección heredada).
La base sigue siendo la barrera final (23P01 → `PERIOD_OVERLAP`).

Dos cadencias DISTINTAS siguen conviviendo sobre los mismos días a propósito (el
semanal y el mensual se superponen por decisión del dueño). Pero un período
NUEVO con cadencia **sí** se rechaza si se superpone con un período HEREDADO sin
cadencia de la misma sede (`PERIOD_OVERLAP`, 409): ese heredado no lo acotaba
ningún ciclo, así que le pagó el fijo a **todo el plantel**, y abrir encima un
rango con cadencia pagaría dos veces los mismos días. La restricción de 063 no ve
ese cruce —el cubo vacío es distinto del de las tres cadencias—, así que la
guarda vive en el servicio; los períodos heredados no se reescriben.

### Exclusión del empleado de otro ciclo

Cuando las DOS cadencias están definidas y **difieren**, el empleado se excluye
en `computePayrollLines` al armar el conjunto de empleados: no hay ítem, no hay
comisiones y su factura del rango no entra en ningún `detail_json` ni en ningún
total. La misma lista acota las escrituras que consumen compromisos del empleado
(vales marcados `descontada` y deudas marcadas aplicadas): no se consume el vale
o la deuda de un excluido si no hay ítem que los descuente; quedan para su
propio ciclo. Si CUALQUIERA de las dos cadencias falta, rige el comportamiento
de hoy (prorrateo por días más comisiones).

En la pantalla, el excluido sigue apareciendo en la tabla del borrador con los
montos en blanco (`—`), que es como ya se renderiza un empleado sin ítem; la
tabla del período (cerrado o ya calculado) sólo lista ítems, así que no lo
inventa con ceros.

### El piso por cadencia: nunca fue la guarda del envío

`nextPeriodStartDate` acepta la cadencia y sólo mira los períodos del MISMO
cubo: devuelve el día siguiente al fin más lejano de ese ciclo. Un período de
otra cadencia puede superponerse A PROPÓSITO y no la mueve. Sin cadencia, el cubo
es el vacío (`coalesce(frequency, '')`) y sólo acotan los períodos sin cadencia,
que es la protección heredada.

F9/F10: ese valor NO es la guarda del envío, y desde F10 tampoco se muestra en
el diálogo (que no pregunta nada). Como piso era más estricto que el servidor
—floorea el inicio en el día siguiente al `end_date` más lejano, no en el
"próximo ciclo sin liquidar"—, un ciclo de un **hueco a mitad de la historia**
(una cadencia que nunca se liquidó mientras las otras sí, o un borrador borrado
entre ciclos cerrados) caía por debajo del piso y el diálogo rechazaba con "el
período no puede empezar antes de X" el ciclo que el aviso acababa de ofrecer.
La guarda del envío (`handleOpen`) es la MISMA regla del aviso: **un ciclo ya
liquidado no se puede abrir** (`isPayrollCycleSettled` sobre el ciclo elegido) y
cualquier ciclo sin liquidar pasa para que decida el servidor
(`openPayrollPeriod`). F10 agregó la segunda verdad al mismo lugar:
`isRangeBeforePayrollStart` rechaza el ciclo anterior al arranque de la nómina
nombrando la fecha. La guarda de solape del mismo cubo se conserva, con el
mensaje que nombra el período en conflicto.

## Ciclo cerrado del período (F7)

Regla del dueño (2026-10-01): los períodos NO son fechas libres. La nómina se
cierra siempre al ciclo de su cadencia, de **domingo a sábado**, y el rango se
**deriva** del ciclo. Elegir un lunes (o cualquier rango que no sea un ciclo) es
imposible por construcción, no una recomendación.

| Cadencia    | Ciclo     | Días | Rango de ejemplo        |
| ----------- | --------- | ---- | ----------------------- |
| `semanal`   | 1 semana  | 7    | 2026-08-30 → 2026-09-05 |
| `quincenal` | 2 semanas | 14   | 2026-08-30 → 2026-09-12 |
| `mensual`   | 4 semanas | 28   | 2026-08-30 → 2026-09-26 |

Las tres empiezan el domingo y cierran el sábado. Consecuencia ACEPTADA por el
dueño: el mensual de 4 semanas da 13 liquidaciones al año en vez de 12 (igual
que el semanal, que ya pagaba ≈13 sueldos). No se reabre.

### La derivación

Las funciones puras viven en `schemas.ts` y las comparten el diálogo, el
esquema y el servicio:

- `PAY_CYCLE_CALENDAR_DAYS` / `calendarCycleDaysForFrequency`: 7, 14 y 28. NO
es `PAY_CYCLE_DAYS` (7/15/30), que sigue siendo la base COMERCIAL de 30 días
con la que se prorratea un rango que no es un ciclo.
- `payrollCycleRange({ frequency, cycleEndDate })`: dado el **sábado que cierra
el ciclo**, devuelve `[end − (días − 1), end]`. Con `referenceDate` devuelve el
ciclo que CONTIENE esa fecha (su cierre es el sábado en o después de ella). Sin
cadencia, con una fecha imposible o con un cierre que no es sábado, devuelve
`null`.
- `lastCompletedCycleEndDate(referenceDate)`: el sábado ANTERIOR a la fecha de
referencia. Un ciclo se completa cuando ya pasó su sábado; el domingo se liquida
la semana que cerró el sábado anterior.
- `lastCompletedPayrollCycles({ frequency, referenceDate, count })`: los últimos
ciclos completados, el más reciente PRIMERO, cada uno con su `label` y su rango.
F10: ya no alimenta ningún selector —el diálogo no pregunta ciclos—; sigue siendo
la derivación pura de "qué ciclos ya cerraron" (la usan las pruebas y cualquier
superficie que necesite esa lista).
- `isPayrollCycleRange({ frequency, startDate, endDate })`: **true solo si** el
rango empieza DOMINGO, termina SÁBADO y dura 7, 14 o 28 días contando los dos
extremos. Un lunes, un rango de 8/13/29 días, uno corrido un día o uno del
largo de otra cadencia son `false`.

### El período nuevo: sin rango libre

`openPeriodSchema` exige `frequency` y `cycle_end_date` (el sábado de cierre).
`start_date`/`end_date` siguen aceptándose por compatibilidad, pero son una
segunda opinión: si no coinciden con el ciclo derivado, el envío se rechaza
(`VALIDATION`). `openPayrollPeriod` DERIVA el rango con `payrollCycleRange` y,
con la fecha de arranque configurada, con `resolveOpenPayrollRange` (ciclo
completo o primer ciclo recortado; ver "Fecha de inicio de la nómina de la
sede"), y no acepta un rango arbitrario; la guarda de solape, la regla de ciclo
ya liquidado y el mapeo de `23P01` siguen vigentes. Con los ciclos embaldosando
el calendario, la guarda por cadencia es lo que impide liquidar dos veces el
mismo ciclo: el semanal y el mensual se superponen a propósito, dos del mismo
ciclo no. Un período heredado sin cadencia tampoco se puede tapar con uno nuevo
con cadencia: ver "La guarda de solape, acotada por cadencia".

Un período NUEVO sin cadencia ya no es válido: "sin cadencia" desapareció del
diálogo. Los períodos HEREDADOS con `frequency = NULL` no se tocan y siguen
calculándose por la vía F3/F5 (`prorateFixedSalary`), exactamente como hoy.

### El ciclo completo paga la fracción entera

Un rango que ES un ciclo cerrado paga la fracción entera de la cadencia (1/4,
1/2, 1) aunque la base comercial de 30 días sea más larga: el mensual de 4
semanas son 28 días, y sin esta regla pagaría `28/30` del sueldo y los 13
cierres del año no serían 13 sueldos. El prorrateo del ciclo parcial (F5) sigue
intacto para los rangos que NO son un ciclo (los heredados).

### En pantalla

F10: el diálogo "Abrir período" NO tiene ningún control propio de rango: no hay
campos de fecha, ni selector de cadencia, ni selector de ciclos. La única
entrada es el aviso de ciclos cerrados sin liquidar (ver "Fecha de inicio de la
nómina de la sede"): su ciclo queda elegido, la lista de pendientes se ofrece
con el MÁS ATRASADO preseleccionado, y debajo se lee el rango derivado en texto.
La nota de la primera liquidación (F5/F10) y los avisos del diálogo siguen en su
lugar.

## Ciclos cerrados que faltan por liquidar (F9)

Pedido del dueño (2026-10-02): la pantalla de períodos no le decía si la sede
venía atrasada. Su ejemplo: si el ciclo quincenal venció y no se liquidó, la
pantalla tiene que DECIRLO —y lo mismo el mensual— siempre que haya empleados
con esa cadencia. Sin ese aviso, una sede podía liquidar semanal durante dos
meses y nunca hacer una sola liquidación quincenal para quien cobra así; nadie
lo notaba hasta mucho después.

### El detector

`pendingPayrollSettlements({ periods, employees, referenceDate, limit })` en
`schemas.ts` es puro y devuelve los ciclos **pendientes**: para cada cadencia,
todo ciclo ya CERRADO (su sábado es anterior a `referenceDate`, la misma cuenta
de F7) que NO esté cubierto por un período de la sede —de su MISMA cadencia, o
por uno heredado sin cadencia, que le pagó a todo el plantel— y que tenga al
menos un empleado. Cada entrada lleva `frequency`, el rango del
ciclo, su `label`, `employeeCount` y hasta `PENDING_SETTLEMENT_NAME_LIMIT` (3)
nombres.

- **Cubierto** = un período de la sede se solapa con el ciclo, aunque no coincida
  exactamente, y **o bien** es de la MISMA cadencia **o bien** es un período
  HEREDADO sin cadencia (`isPayrollCycleSettled`, que reutiliza
  `periodCadenceBucket` y `rangesOverlap`). Un período de OTRA cadencia NO tacha
  el ciclo: la guarda de solape (063) los trata como cubos distintos y deja que se
  superpongan a propósito, así que el ciclo de una cadencia sigue sin su
  liquidación de esa cadencia. Un heredado sin cadencia, en cambio, **cubre el
  ciclo de CUALQUIER cadencia**: no lo acotaba ningún ciclo, así que le pagó el
  fijo a todo el plantel y esos días ya salieron de la nómina; reportarlo como
  pendiente era el aviso gritando de más, y un aviso que grita de más deja de
  mirarse. La cobertura es SIMÉTRICA con la apertura: `openPayrollPeriod` también
  rechaza un período nuevo con cadencia que se superponga con un heredado, por los
  mismos días doblemente pagados.
- **Sólo con gente**: una cadencia sin ningún empleado ACTIVO no se reporta.
  `pay_frequency` `NULL` (o fuera del catálogo) es ausencia de cadencia, no una
  cadencia más.
- **El ciclo en curso no se reporta**: sólo cuenta lo ya cerrado, o sea el sábado
  anterior a la fecha de referencia.

### El límite: la historia de la sede, no la del calendario

El recorrido se detiene en el **arranque de la sede**: la fecha de inicio más
antigua de sus períodos. Antes de eso no había nada que liquidar, así que no se
reporta historia anterior (nada de arrastrar años de ciclos de un negocio que no
existía). Consecuencia directa y deliberada: **sin ningún período no se reporta
NADA** —una sede sin historia no tiene atraso—, y un ciclo que terminó antes del
primer período tampoco aparece.

F10 (068): cuando la sede tiene **fecha de arranque configurada**, esa fecha
REEMPLAZA a la evidencia de la historia como cota del aviso —no se combina por el
máximo: la fecha es la autoridad sobre dónde empieza la nómina— y el aviso sigue
vivo aunque la sede no tenga ningún período, porque en una sede nueva el primer
ciclo es justamente lo que falta liquidar. Ver "Fecha de inicio de la nómina de
la sede".

### El tope

`PENDING_SETTLEMENT_LIMIT` (3) ciclos **por cadencia**, tomando los más
recientes: una sede atrasada hace meses ve que el atraso existe sin que el aviso
crezca sin control, y una cadencia muy atrasada no tapa a las otras dos. La lista
sale ordenada con lo MÁS ATRASADO primero (por fecha de cierre, y a igualdad por
el orden del catálogo), y los nombres van en orden determinista.

### En pantalla

El admin ve el aviso arriba de la sección **Períodos** (un `Alert` de aviso,
porque es un pendiente que exige acción, no un fallo de la pantalla):

> Falta liquidar el ciclo quincenal 20 sep – 3 oct 2026 (3 empleados con esa
> cadencia: Ana López, Beto Ruiz y Caro Díaz).

Cada entrada es un botón que abre el diálogo **ya posicionado** en su ciclo, así
el atraso no hay que buscarlo a mano. F10: ese botón es la ÚNICA entrada al
diálogo de apertura —el selector de cadencia y el de ciclos ya no existen, y la
lista del diálogo es la de los pendientes, la más atrasada primero y
preseleccionada—, así que el aviso y lo que se abre no pueden discrepar. La
regla de qué está liquidado sigue siendo `isPayrollCycleSettled` (la misma del
servicio), ahora aplicada al ciclo elegido.

La pantalla deriva la lista de los períodos y la planta que YA llegan leídos (el
resumen de la sede y `listAllEmployees`): **no agrega ninguna lectura por
cadencia**. El servicio la expone además en `listPayrollOverview`, con UNA lectura
más de la planta (paginada y acotada por sede) para que el resumen de la sede sea
completo por sí solo.

## Fecha de inicio de la nómina de la sede (F10, 068)

Decisión del dueño (2026-10-01): el sistema tiene que saber **desde cuándo**
opera la nómina —«la fecha de inicio de la implementación»— para no volver a
apuntar a fechas anteriores. **Nada anterior a esa fecha existe para el
sistema**: no se ofrece, no se liquida y no se puede abrir.

`sedes.payroll_start_date date NULL` (migración 068) guarda esa fecha. Es una
columna de la SEDE y no de cada período: sobrevive a cada liquidación y hay UNA
sola por sede (una tabla de configuración aparte haría indistinguible «sin fila»
de «sin configurar»). `NULL` significa «todavía no configurada» y conserva el
comportamiento de hoy —el aviso se detiene en el arranque de la historia de la
sede (F9)—, así que **aplicar la 068 no cambia ninguna liquidación**: el cambio
empieza cuando el admin fija la fecha. Sin DEFAULT y sin backfill: ninguna sede
queda con una fecha que el dueño no eligió.

### La regla, en un solo lugar

`isRangeBeforePayrollStart({ payrollStartDate, startDate, endDate })` es la única
definición de «es anterior»: un rango lo es cuando su **último día** es anterior
a la fecha. La usan las dos superficies que deciden, y por eso no pueden
discrepar:

- `pendingPayrollSettlements` no reporta un ciclo que cierre antes de la fecha.
  Con la fecha configurada, su cota REEMPLAZA al arranque por evidencia de F9 (no
  se combina por el máximo) y el aviso sigue aunque la sede todavía no tenga
  períodos. El rango reportado es el que se va a ABRIR: si la fecha cae dentro
  del ciclo, la entrada sale recortada (`28 sep – 3 oct 2026` y no
  `27 sep – 3 oct 2026`).
- `openPayrollPeriod` rechaza con `VALIDATION` (400), antes del INSERT, un ciclo
  que cierre antes de la fecha y **nombra la fecha** en el mensaje.

### El primer ciclo se recorta (y lo paga la prorrata de F5)

`resolveOpenPayrollRange({ frequency, cycleEndDate, payrollStartDate, periods })`
es el ÚNICO validador de la forma del rango y acepta **exactamente dos formas**:

1. Un **ciclo completo** de la cadencia (domingo a sábado; 7/14/28 días). Es la
   forma normal de todos los ciclos posteriores al primero, y también la del
   primer ciclo cuando empieza el mismo día del arranque o después.
2. El **primer ciclo** —el que CONTIENE la fecha de arranque— **recortado** a esa
   fecha: empieza el día del arranque y termina el sábado de su ciclo. Sólo vale
   como PRIMERO: si esa MISMA cadencia ya tiene períodos, el recorte se rechaza
   (`not-first-cycle`), porque la única primera liquidación de la cadencia ya
   ocurrió. Un período HEREDADO sin cadencia no es historia de la cadencia; sí lo
   es la de otra cadencia.

El recorte no inventa aritmética: el rango más corto lo paga la prorrata de ciclo
parcial de F5 (`días del período / días del ciclo`). Con un sueldo mensual de
1.500.000 y un arranque el jueves 1 de octubre de 2026:

| Cadencia  | Primer ciclo        | Fracción | Prorrata | Pago      |
| --------- | ------------------- | -------- | -------- | --------- |
| quincenal | 1 – 10 oct (10 días) | 1/2      | 10/15    | 500.000   |
| semanal   | 1 – 3 oct (3 días)   | 1/4      | 3/7      | 160.714   |
| mensual   | 1 – 24 oct (24 días) | 1        | 24/30    | 1.200.000 |

El caso que el dueño describió: el empleado **quincenal** cobra su primera
liquidación del 1 al 10 de octubre (500.000) y esa liquidación **incluye la
primera semana** (1–3 de octubre), que no se pagó aparte; el ciclo quincenal
siguiente es completo y vuelve a 750.000.

### Configurarlo

La CONFIGURACIÓN de la fecha ya no es de este módulo: es de la superficie de
PLATAFORMA. `setPlatformPayrollStartDate({ sede_id, payroll_start_date }, actor)`
en `platform/service.ts`, expuesta por `setPlatformPayrollStartDateAction` para
el rol `superadmin`, es la ÚNICA escritura de la columna y deja AUDITORÍA
(`platform.payroll_start_date_set`: actor, sede objetivo y los dos valores, el
anterior y el nuevo). Valida la forma de la fecha con el mismo esquema que este
módulo (`payrollStartDateSchema`, que la plataforma reutiliza desde acá: una
fecha futura es legal porque la implementación puede arrancar en el ciclo que
viene) y `null` vuelve a «sin configurar». Si la 068 no está aplicada (columna
inexistente, `42703`), la escritura responde un mensaje accionable que nombra la
migración, en vez del error crudo de la base.

Lo que queda acá es la LECTURA: `getPayrollStartDate(sedeId)` en `service.ts`, con
el guard de admin en la superficie (`requirePayrollAdmin`), como el resto del
módulo. Es la que alimentan el aviso de pendientes y el diálogo de apertura, los
dos pisos de los ciclos que se ofrecen y se abren. Con la 068 sin aplicada
devuelve `null` —sin fecha, el módulo hace lo de hoy— en vez de un error interno.

Equivalente manual, UNA línea (la superficie de plataforma hace lo mismo):

```sql
UPDATE public.sedes SET payroll_start_date = '2026-10-05' WHERE id = '<sede>';
```

### En pantalla

- **El control de la fecha** (sólo admin, en la pantalla de nómina): etiqueta
  "Fecha de inicio de la nómina", el campo y la ayuda que dice que nada anterior
  a esa fecha existe para el sistema (y que el primer ciclo de cada cadencia se
  liquida desde ahí). Está siempre visible —tampoco cuando ya está configurada:
  se puede corregir y se puede volver a «sin configurar» dejando el campo vacío—
  y, cuando está en NULL, la ayuda y el aviso invitan a fijarla. Es
  deliberadamente MÍNIMO (etiqueta, campo y ayuda, sin disposición propia)
  porque la CONFIGURACIÓN se muda a la superficie de plataforma (super admin):
  esta pantalla conserva la LECTURA, que es la que el aviso y el diálogo
  necesitan. La fecha llega leída del servidor como valor inicial
  (`initialPayrollStartDate`, mismo patrón que `initialPeriods`).
- **El diálogo de apertura no pregunta nada**: ya no hay selector de cadencia ni
  de ciclo, y no hay ningún campo de fecha. La única entrada es el aviso de
  ciclos pendientes: cada entrada (o el botón "Abrir período", que nace en la
  MÁS ATRASADA) abre el diálogo con ese ciclo ya elegido y una lista de los
  pendientes —el más atrasado primero, preseleccionado— que sólo se confirma. El
  rango se muestra derivado ("Del 1 oct 2026 al 10 oct 2026 (10 días)") y un
  ciclo recortado lo dice: "Primer ciclo recortado…". Sin ciclos pendientes el
  diálogo no ofrece nada y lo dice.
- La guarda del envío repite las DOS verdades del servidor con las mismas
  funciones puras: la regla de liquidación (`isPayrollCycleSettled`) y la de la
  fecha (`isRangeBeforePayrollStart`, que rechaza nombrando la fecha). El
  servidor sigue siendo la autoridad.

Léase `getPayrollStartDate` en `service.ts` y `getPayrollStartDateAction` en
`actions.ts` (solo admin, `requirePayrollAdmin`; declaradas en la tabla de roles de
`tests/action-guards.test.ts`). La ESCRITURA ya no es una superficie de este módulo:
vive en `platform/service.ts` y `platform/actions.ts`
(`setPlatformPayrollStartDate` / `setPlatformPayrollStartDateAction`, solo
`superadmin`), con su propia fila en esa misma tabla.

## Detalle de la liquidación: facturas y vales (F6)

Desde el detalle de una liquidación (`el diálogo "Liquidación X → Y"`), cada fila
de la tabla tiene un botón **"Ver facturas y vales"** que abre un modal con las
dos listas de ese empleado y el detalle de cada una. Sirve tanto para el período
cerrado como para el borrador (mismo botón en las dos tablas) y para el empleado
en su propio recibo.

### La lectura

`getPayrollSettlementSources(sedeId, periodId, employeeId)` devuelve las fuentes
de la liquidación de UN empleado de UN período, sin tabla ni columna nuevas:

- **Facturas**: se agrupan desde `payroll_items.detail_json`. El detalle guarda
  una línea por factura/ítem, así que el read las **suma por `invoice_id`** y
  devuelve `{ invoice_id, consecutive_number, commission }` —una fila por
  factura—. No se consulta `invoices`: el detalle persistido ya es la fuente de
  la comisión líquida y no guarda la fecha de la factura, por eso el modal no
  muestra fecha de factura.
- **Ajuste del mixto**: la línea `item_type = "ajuste_mixto"` (F3) NO es una
  factura. Se separa con su monto (negativo) en `adjustment`; una línea sin
  `invoice_id` tampoco inventa una fila.
- **Vales**: se leen de `voucher_requests` con la **misma forma que el cálculo**
  (sede + `request_date` dentro del rango + `voucherStatusesForScope("vigentes_y_descontados")`:
  pendiente/aprobada/descontada), acotados por empleado. Devuelve solo
  `{ id, request_date, amount, status }`; el detalle se abre con la lectura de
  vales existente.

El alcance es la clave: el período se valida contra la sede del actor
(`getPeriodOrThrow`), el ítem por `period_id` + `employee_id` y los vales por
`sede_id` + `employee_id`, así que no puede devolver la nómina de otra sede ni la
de otro empleado. **Sin ítem no hay liquidación**: el read devuelve todo vacío y
no lee los vales del rango (esos vales no entraron a este período: el cálculo no
los tocó, por ejemplo por exclusión de cadencia). Las dos lecturas son
exhaustivas (`readAllPayroll`): una lectura recortada mostraría menos fuentes que
las reales.

La action `getPayrollSettlementSourcesAction(periodId, employeeId)` es el mismo
alcance por fila que `getPeriodDetailAction`: el admin abre el empleado que pida;
el empleado logueado solo la suya (su legajo se resuelve contra la planta
completa y reemplaza el pedido). La caja no entra al módulo
(`requirePayrollViewer`).

### El modal

- **Facturas de la liquidación**: una fila por factura con su consecutivo y la
  comisión que ESTA liquidación le asignó, más un botón **"Ver detalle"** que
  abre la factura con la lectura EXISTENTE de facturación (`getInvoiceAction`),
  en un panel en línea dentro del mismo modal (consecutivo, estado, cliente,
  fecha, total/pagado/saldo y sus ítems).
- **Vales de la liquidación**: una fila por vale con fecha, monto y estado, más
  un botón **"Ver detalle"** que abre el vale con la lectura EXISTENTE de vales
  (`listVouchersAction`, filtrada por el mismo empleado y la misma fecha de
  solicitud).
- **Ajuste del mixto**: bloque aparte que explica que el básico absorbió ese
  porcentaje y que ya no se suma aparte, con el monto en negativo tal como vive
  en `detail_json`. Nunca se rotula como "Factura #ajuste_mixto".
- **Vacíos honestos**: "La liquidación no tiene facturas…" / "…no tiene vales…"
  son texto plano (estado esperado, no un aviso) y describen que el período no
tuvo comisiones por factura o vales descontados.

## Límites de lectura

- Navegación instantánea: `listPeriods` acotado a 20 periodos recientes, `listVouchers` a 50 vales recientes; la pantalla de vales nace acotada al día de hoy (Bogotá, `date_from`/`date_to` incluyentes) y amplía —o limpia— ese rango desde sus filtros de fecha; el detalle del periodo (ítems + saldos) se carga bajo demanda al seleccionar.
