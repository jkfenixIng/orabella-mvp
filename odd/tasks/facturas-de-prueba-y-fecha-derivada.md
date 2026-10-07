# Facturas de prueba y la fecha declarada derivada

## Objective

Dos cosas, independientes entre sí, para que la primera liquidación de nómina se pueda **probar hoy**
operando la aplicación:

1. **La fecha declarada deja de ser una pregunta vacía** y pasa a ser un valor **derivado**: el
   diálogo la precarga con el inicio del ciclo que ya ofreció, y el campo queda editable sólo para
   el caso real de una instalación que arrancó a mitad de ciclo.
2. **Un seed de PRUEBAS con facturas pagadas** fechadas dentro del último ciclo cerrado, para que
   la liquidación tenga plata que liquidar sin esperar al sábado.

## Por qué (medido el 2026-10-06)

El dueño reportó: «se supone que la fecha ya no se solicitaba sino que era calculada… me sale [el
mensaje] *La primera liquidación declara desde qué día opera la nómina*», y pidió poder liquidar la
semana en curso para probar con facturas propias. La medición separa las dos cosas:

| Hecho medido | Dónde |
| --- | --- |
| La fecha **sí se declara** la primera vez — fue decisión del dueño (opción B, 4-oct) | `schemas.ts:1382-1400` (`declared-required`), `openPayrollRejectionMessage` |
| Lo **derivado** es el piso posterior: `min(start_date)` de los períodos | `schemas.ts:1269` `payrollHistoryFloor` |
| El campo nace **vacío**, sin default, aunque el ciclo ya se conoce | `payroll-client.tsx:3053` (`value={openDeclaredStart}`, estado inicial `""` en `:1264`), `min`/`max` en `:3054-3055` |
| El mínimo y el máximo **ya están derivados** del ciclo | `payroll-client.tsx:2073-2077`: `declaredMin = openCycle.start_date`, `declaredMax = min(openCycle.end_date, hoy)` |
| Una factura nueva **no tiene fecha elegible**: la pone el servidor | `invoices.created_at` (`001:5444`, `DEFAULT now()`); no hay campo de fecha en el alta |
| La nómina filtra facturas por **ese** timestamp | `payroll/service.ts:1812-1816` (`.eq("status","Pagada")`, `.gte/.lte("created_at", …)`) |
| Sólo se ofrecen ciclos **cerrados** | `schemas.ts:1604` `pendingPayrollSettlements`, regla 2 |

Conclusión: con 0 períodos, hoy (martes 6) el único ciclo abrible es **27-sep → 3-oct**, y una
factura emitida hoy cae en **4-oct → 10-oct**, que no se ofrece porque no cerró. Esperar al domingo
11 era la única salida sin datos de prueba. **Liquidar el ciclo en curso se descartó**: es un cambio
de regla de plata (un ciclo abierto puede tener la mitad de las ventas y el período no recalcula),
no un default. El dueño eligió esta unidad.

## Decisión del dueño (2026-10-06)

Opción 1 de tres: **sembrar facturas de prueba + precargar la fecha**. Descartó permitir liquidar el
ciclo en curso y descartó esperar al domingo.

## Diseño

### U1 — la fecha declarada, derivada

- `schemas.ts`: una **regla pura** con nombre — `declaredStartForFirstLiquidation({ typed, cycleStartDate })`
  → `typed || cycleStartDate`. Una sola definición, como el resto de las reglas de nómina.
- `payroll-client.tsx`: el valor efectivo del campo y el que viaja como `declared_start_date` salen
  de esa función. Al cambiar de ciclo, el `onChange` que hoy limpia el estado (`:3022`) queda
  **correcto por construcción**: vacío ⇒ el default del ciclo nuevo.
- **Ninguna regla cambia**: la declaración sigue siendo un hecho de la primera liquidación, y la
  copia del diálogo sigue siendo cierta.
- Cuidado de orden: hoy `declaredStartDate` se calcula en `:2067` y `declaredMin` en `:2073`.

### U2 — seed de facturas de prueba

Archivo nuevo `app/supabase/seeds/test-invoices.sql`, con el mismo contrato que `smoke.sql`:

- **Interlock PRUEBAS-only** con las DOS condiciones de `smoke.sql:51` (`current_user` en sus dos
  formas aceptadas + huella de datos `%ejemplo.co`), que aborta **antes de escribir**.
- **Ciclo derivado, nunca hardcodeado**: el último sábado cerrado, calculado en la convención del
  módulo (`(now() AT TIME ZONE 'America/Bogota')::date`), para que el seed siga sirviendo la semana
  que viene.
- **Sólo servicios, no productos**: así no hay que inventar movimientos de stock. Los precios salen
  del fixture (`acceptance.sql:124`+).
- **Atribución por empleado**, que es la base de la comisión (`invoice_items.employee_id` es NOT
  NULL, `001:5281`): Lucía (fijo, semanal), Andrés (porcentaje 35%, semanal) y Paola (mixto 20%,
  quincenal). Un mismo día del ciclo cae en el ciclo semanal (27-sep→3-oct) y en el quincenal
  (20-sep→3-oct), así que **una sola siembra sirve a las tres cadencias** y la exclusión por
  cadencia (`periodExcludesEmployeeByCadence`) hace que cada período pague sólo a su gente.
- **Cobro coherente**: `status = 'Pagada'` **con** sus `invoice_payments` (`method_code` del fixture,
  `amount` = total, `cash_shift_id` NULL — es nulable, `001:5351`). Una factura pagada sin pago
  sería un dato incoherente que el módulo de caja no podría explicar.
- **Consecutivos**: al final, `invoice_sequences.last_number = GREATEST(last_number,
  max(consecutive_number))` — sin esto, la próxima factura real choca (`001:5397`).
- **Idempotente**: `idempotency_key` fijo por factura (uuid) contra
  `uq_invoices_sede_idempotency_key` (`001:7149`) y `ON CONFLICT DO NOTHING`.
- **Identificables y removibles**: `client_name` lleva un marcador fijo, para poder encontrarlas y
  borrarlas con una sola sentencia.
- **Lo que NO hace, declarado en su encabezado**: no crea turnos de caja, no toca stock, no crea
  períodos de nómina (el período lo abre el dueño en la UI: eso **es** el smoke test) y no escribe
  `sedes.payroll_start_date`.

## Tareas

- [x] **U1** — La regla pura y su test en rojo, después el wiring del diálogo.
  **HECHO** — Writer `muxdln6d-4-o2le`, con **RED observado**: `npx vitest run tests/payroll.test.ts`
  → `TypeError: declaredStartForFirstLiquidation is not a function`, **3 fallas / 514 pasando**;
  después de implementar, **517/517**, `tsc --noEmit` limpio y `eslint` limpio sobre los tres
  archivos tocados.

  La regla vive en `schemas.ts:1299` (`return args.typed || args.cycleStartDate;`) y la consumen
  **dos** call sites del mismo símbolo, que es lo que evita que el campo diga una cosa y el envío
  mande otra: `payroll-client.tsx:2076-2081` (valor efectivo ⇒ `value={declaredStartDate}` en
  `:3066`) y `:1603-1612` (el cuerpo del envío).

  El **control negativo** del test es el que vale: afirma que el default es el inicio del ciclo
  **y que no es `bogotaDay()`**, con el caso concreto escrito (el ciclo cerrado 27-sep→3-oct, y el
  día en que se abre el diálogo es el 4-oct). Sin ese control, un default que cayera en «hoy»
  pasaría inadvertido y volvería a mentir sobre el arranque.

  Verificado por mí, no por su informe: leí la regla, los dos call sites y el control negativo.

  **Sin verificar y declarado por el writer**: ninguna prueba de este repo **renderiza** el diálogo,
  así que lo que está fijado es la regla y la forma del wiring, no el DOM. Nadie miró el campo en
  un navegador real.

- [x] **U2** — El seed, con su interlock, su ciclo derivado y sus pagos.
  **HECHO** — Writer `muxdrs3i-5-duqk`: `app/supabase/seeds/test-invoices.sql`, 487 líneas,
  interlock PRUEBAS-only heredado de `smoke.sql:51-77`, **6 sentencias**. Escribe 3 facturas
  pagadas en las fechas 28-sep / 30-sep / 2-oct (12:00 Bogotá), 6 líneas de servicio atribuidas
  por empleado, 3 filas de impuesto y 3 de pago, y mueve el contador de facturas.

  **Dos correcciones que el writer le hizo a mi brief, y las dos valían más que el seed**:
  1. **El contador vivo no es `invoice_sequences`.** Esa tabla (`001:5397`) es legado: desde la 072
     el contador es la clave `'invoice_sequence'` de `system_settings`, y `next_invoice_number()`
     bloquea ESA fila (`001:3810-3832`). Mi brief mandaba escribir la tabla vieja — habría dejado
     el contador vivo intacto, o sea **exactamente la colisión que queríamos evitar**. Verificado
     por mí leyendo la función, no su informe.
  2. **El fixture no tiene los impuestos en 0**: `acceptance.sql:177` activa IVA 19% (ICA 0%
     inactivo). El seed, en vez de hardcodear, **deriva** los impuestos de `tax_configs WHERE
     is_active` con el mismo redondeo que `snapshotInvoiceTaxes`. Con la base sin impuestos
     activos no escribiría ninguna fila: la conducta es de la instalación, no del seed.

- [x] **U3** — Aplicarlo a PRUEBAS y medir por lectura.
  **HECHO** — 1ª corrida `INSERT 0 3 / 0 3 / 0 1` y **2ª corrida `INSERT 0 0` × 4** (idempotente,
  medido). Contador: 0 → 3.

  | Medición viva | Resultado |
  | --- | --- |
  | Facturas sembradas | 3, `status = Pagada`, 9-28 / 9-30 / 10-2, totales 124.950 / 285.600 / 137.445 |
  | Contraprestación coherente | 6 líneas, 3 impuestos, **3 pagos** (una factura pagada sin pago sería un dato que caja no puede explicar) |
  | El filtro de la nómina las ve | **3 facturas (547.995) en cada una de las tres cadencias**: semanal 27-sep→3-oct, quincenal 20-sep→3-oct, mensual 6-sep→3-oct |
  | Base de comisión por empleado | quincenal: Diego (porcentaje 120.000), Marco (fijo 35.000), **Paola (mixto 60.000)** → **los tres tipos en UNA cadencia**; semanal: Andrés (porcentaje) y Lucía (fijo) → dos |
  | Fidelidad de `commission_mode` | `deriveCommissionMode('servicio', false, undefined)` → **`porcentaje`** (`billing/schemas.ts:37`), exactamente lo que escribió el seed |

  **Mi brief estaba mal en un punto, y el writer lo midió**: pedí que semanal y quincenal mostraran
  los tres tipos. **En el fixture ningún `mixto` tiene cadencia semanal** (Lucía y Carolina son
  `fijo`, Andrés `porcentaje`), así que semanal muestra dos tipos. Los tres conviven en
  **quincenal**, que es donde el dueño va a poder ver fijo + porcentaje + mixto en un mismo ciclo.

- [x] **U4** — Verificación independiente (read-only) de las dos superficies. **`muxe7pp7-6-ou6f`,
  sin un solo FAIL.**

  | Compuerta y checks | Veredicto |
  | --- | --- |
  | Suite completa + `tsc` | **48 archivos, 2.439 pruebas, 0 fallas** · `tsc` exit 0 · `eslint` limpio |
  | Diff numstat | `schemas.ts` **27/0** · `payroll-client.tsx` 18/5 (las 5 bajas son comentarios y dos `const` viejos) · tests 80/0 ⇒ ninguna regla existente tocada |
  | La regla y sus DOS consumidores | mismo símbolo en el campo y en el cuerpo del envío; `openDeclaredStart` crudo se lee en **un solo** lugar (como `typed`), y no hay camino que lo saltee |
  | El default es válido por construcción | `declaredMin = inicio del ciclo` y `declaredMax = min(fin del ciclo, hoy)` ⇒ el default cae adentro |
  | Falsificación del diálogo | un valor escrito fuera de rango lo rechaza `resolveOpenPayrollRange` y la guarda del servicio: **no hay camino** de valor rechazado a la base |
  | Fidelidad del seed (4 columnas, derivadas por el verificador) | **MATCH** en las cuatro: el contador vivo, `commission_mode`, el snapshot de impuestos y `idempotency_key` NULL en pagos |
  | La regla del ciclo | SQL y TS evaluados para **los 7 días de la semana**: idénticos; las 3 facturas caen en las tres cadencias |
  | Removibilidad | borra exactamente 3 facturas + 9 hijas, sin huérfanos (`ON DELETE CASCADE`) |

  **Lo que declaró no confirmable**: que los logs de las dos corridas vengan de este archivo contra
  esta base (son texto plano sin firma: no re-ejecutó el seed), y dos referencias de línea del
  encabezado que no abrió.

  **Tres defectos, ninguno de plata**:
  1. **El interlock no discrimina por rol** — su primera condición acepta el `postgres` de cualquier
     proyecto, así que lo único que separa PRUEBAS es la huella `@ejemplo.co`. Es el riesgo residual
     **heredado** de `smoke.sql`, no nuevo; lo que cambia con este seed es la consecuencia: una base
     con el fixture restaurado y sin las marcas recibiría **3 facturas pagadas falsas** con
     consecutivos reservados. Queda dicho con esas palabras.
  2. **El `DELETE` documentado** borraría también una factura real que se llamara igual, y abortaría
     (`RESTRICT`) si un pago de comisión alguna vez referenciara una sembrada: falla seguro, sin
     huérfanos.
  3. **Una trampa latente, no un defecto**: el cuerpo del envío (`:1612`) lee `declaredStartDate`,
     declarada en `:2076`. **No es un TDZ**: ese uso vive dentro de `async function handleOpen`, que
     corre al enviar, después del render y por lo tanto después de inicializar la constante —lo
     verifiqué leyendo la función, no por el informe—. La trampa aparecería sólo si un lector
     **nuevo** se colocara antes en el camino de render, y eso ninguna prueba de este repo lo ve
     (no hay prueba que renderice el diálogo). **No se toca código ya verificado por un riesgo
     especulativo**: queda declarado acá.
- [ ] **U3** — Aplicarlo a PRUEBAS y medir por lectura: cuántas facturas, en qué rango, y que el
      camino de lectura de la nómina las vea.
- [ ] **U4** — Verificación independiente (read-only) de las dos superficies.
- [ ] **U5** — Commit de cada unidad de trabajo, con su documentación.
## Riesgos

- **El seed escribe datos de negocio** (facturas). Es PRUEBAS y está marcado, pero es la primera vez
  que un seed siembra facturas: el interlock hereda el riesgo residual declarado de `smoke.sql`
  (el rol `postgres` no distingue proyectos; lo que separa PRUEBAS es la huella del fixture).
- **La fecha derivada no puede quedar fuera de `[min, max]`**: el default es el propio `min`, y el
  `max` es `min(fin del ciclo, hoy)`, así que el resultado es válido por construcción. Hay que
  **probarlo**, no razonarlo.
