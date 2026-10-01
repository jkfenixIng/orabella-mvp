# 414 (URI Too Long) en los filtros de caja — cierre de la clase

## Objective
Cerrar la clase de defecto **`414` (URI Too Long)** —y su hermana, el **techo de filas por request** del
Data API— en las lecturas de `app/src/features/cash/service.ts` cuyas listas `.in(...)` crecen con el
volumen de turnos (vista del día, historial y arqueo del cierre). Es el residual declarado en `77a4591`
(CL-21) y sus hermanos idénticos, en el mismo módulo.

## Contexto
- `77a4591` (HEAD) declaró: *"Residual declarado y NO arreglado, de la misma familia:
  `fetchInvoicePaymentsByShift` sigue mandando listas de ids SIN TROCEAR en sus tres `.in(...)`. Con
  muchas facturas la URL puede dar 414; el fallo es RUIDOSO (READ_INCOMPLETE, nada escrito) pero deja la
  vista sin salida. Nómina ya trocea con `chunkIds`/`IN_FILTER_CHUNK_SIZE`."*
- Las dos piezas de la casa ya existen en `app/src/shared/lib/paged.ts`: `chunkIds` /
  `IN_FILTER_CHUNK_SIZE = 100` (tamaño de URL) y `readAllPaged` / `readPagedBatches` (lectura
  exhaustiva, que falla A LA VISTA). En caja, `readAllSource` traduce `PagedReadError` a
  `CashError("READ_INCOMPLETE", 500)`.

## Superficie medida (inventario, no enumeración)
Todas en `app/src/features/cash/service.ts`.

| # | función | tabla | filtro | lista que crece | hoy |
| --- | --- | --- | --- | --- | --- |
| 1 | `fetchCountTotals` (`:352`) | `cash_shift_counts` | `shift_id` | `shiftIds` | `.in` sin trocear **y sin paginar** |
| 2 | `fetchPayoutTotals` (`:443`) | `commission_payouts` | `cash_shift_id` | `shiftIds` | paginada, `.in` sin trocear |
| 3 | `fetchVoucherOutRows` (`:511`) | `voucher_requests` | `cash_shift_id` | `shiftIds` | paginada, `.in` sin trocear |
| 4 | `fetchInvoicePaymentsByShift` (`:662`) | `invoice_payments` | `cash_shift_id` | `shiftIds` | paginada, `.in` sin trocear |
| 5 | idem (`:676`) | `invoices` | `cash_shift_id` | `shiftIds` | paginada, `.in` sin trocear |
| 6 | idem (`:697`) | `invoice_payments` | `invoice_id` | claves de `shiftByInvoice` | paginada, `.in` sin trocear |
| 7 | `fetchRecounts` (`:785`) | `cash_shift_recounts` | `shift_id` | `shiftIds` | `.in` sin trocear **y sin paginar** |
| 8 | `userNames` (`:2236`) | `users` | `id` | ids ya deduplicados | `.in` sin trocear |
| 9 | vista del día (`:2293`) | `payments` | `cash_shift_id` | ids de los turnos del día | paginada, `.in` sin trocear |
| 10 | historial (`:2459`) | `payments` | `cash_shift_id` | ids de los turnos del historial | paginada, `.in` sin trocear |

Los sitios 1 y 7 no están paginados: trocear sin paginar **no alcanza** (100 turnos ≈ 1000 filas de
conteo = el techo por request, otra vez recorte silencioso). Se paginan y se trocean.

Fuera de alcance (inventario, no se toca en esta unidad): `alerts/service.ts:95,199`,
`inventory/service.ts:500,649`, `admin/service.ts:263`, `payroll/service.ts:592,1306`. No están en el
camino del arqueo y no se midieron; quedan reportados.

## No se toca
- La aritmética, las cuatro claves del token, `ARQUEO_STALE` y todos los shapes.
- Las dos lecturas propias de `closeCashShift` (`payments` y `commission_payouts` por `.eq` con el id del
  turno): no llevan `.in`, no pueden dar 414, y el test de CL-21 fija que su texto contenga exactamente
  dos `readAllSource<`.

## Tareas
- [ ] **T1** Helper de casa `readAllSourceInChunks` (deduplica, trocea con `chunkIds`, pagina cada lote con
      el mismo contrato de fallo a la vista).
- [ ] **T2** Aplicarlo a los 10 sitios del inventario (y paginar los 2 crudos).
- [ ] **T3** Tests que fijan: lote ≤ `IN_FILTER_CHUNK_SIZE`, unión completa (sin pérdida ni doble conteo),
      fallo de un lote posterior = falla a la vista, y lista vacía = corto circuito.
- [ ] **T4** Verificación: `npx vitest run tests/cash.test.ts`, `npm test`, `npm run typecheck`,
      `npx eslint src/features/cash/service.ts tests/cash.test.ts`.

## Progress
- [x] **T1–T3** (2026-09-30): un writer sobre `app/src/features/cash/service.ts` (+140/−49) y
      `app/tests/cash.test.ts` (+341). Helper `readAllSourceInChunks` (deduplica → `chunkIds` a 100 →
      `readAllSource` por lote) + los 10 sitios; `fetchCountTotals` y `fetchRecounts` además paginados;
      `userNames` conserva su mapeo `INTERNAL` y solo trocea.
- [x] **T4** (2026-09-30): verificación independiente (`gentle-ai-verify`) del diff: 9 afirmaciones,
      8 CONFIRMADAS y 1 PARCIAL.
- [x] **F1** cerrado (2026-09-30): re-pin de la pareja lista → columna por bloque de consulta en el test
      de la 058.

## Evidencia (verificación independiente)
- `npx vitest run tests/cash.test.ts` → 256/256. `npm test` → 28 archivos / **1346** (base 1341, +5).
  `npm run typecheck` → 0. `npx eslint src/features/cash/service.ts tests/cash.test.ts` → 0.
- Inventario de `.in(...)` del archivo: 7 vía helper (`:366`, `:482`, `:551`, `:703`, `:718`, `:740`,
  `:834`), 2 vía helper (`:2350`, `:2514`) y 1 con bucle explícito de `chunkIds` (`:2292`). Ninguno con
  lista ilimitada. Cero contraejemplos.
- **El `order("id")` agregado es válido**: `cash_shift_counts` tiene `id uuid PRIMARY KEY`
  (`009_cash_control.sql:20`) y `cash_shift_recounts` también (`033_closed_shift_recount.sql:92`);
  ninguna migración posterior los borra. Era el riesgo bloqueante y no se materializa.
- Las dos lecturas propias de `closeCashShift` (`:1835` `payments`, `:1876` `commission_payouts`, por
  `.eq`) siguen intactas: la aserción de texto de CL-21 (dos `readAllSource<`) sigue pasando y
  significando lo mismo (el regex literal no matchea `readAllSourceInChunks<`).
- **Los tests nuevos tienen dientes**, con números medidos: el día siembra 50 turnos × 12 facturas = 600
  ids ⇒ 6 lotes de 100 (`[100,100,100,100,100,100]`), y 101 usuarios ⇒ `[100, 1]`. La primera aserción
  que cae sin trocear es el registro de tamaños de `.in`; y con 1050 filas de conteo el test exige **2
  páginas** (`cash_shift_counts` = 2), así que también prueba la paginación. El test de fallo tardío pega
  en el **segundo** lote histórico (`failAt.invoice_payments = [3]`): sin trocear no hay tercer request.
- Sin doble conteo ni pérdida: el reparto es una partición de la lista **deduplicada** y las dos consultas
  de `invoice_payments` siguen disjuntas (`NULL IN (...)` nunca es verdadero).

## Hallazgos de la verificación
- **F1 (Low, solo tests) — CERRADO.** El writer había dejado tres aserciones de texto más débiles que
  antes; en la 058, tokens sueltos permitían trocar los dos `values:` y borrar del arqueo toda colección
  de factura con el test en verde. Mitigante ya existente: `p_collection_counts.invoice_payments` (≈`:5683`)
  lo caza por comportamiento. Cerrado con aserciones por bloque (lista + columna + orden + ausencia de la
  lista/filtro del otro bloque); con los `values:` trocados fallan 4 de ellas.
- **F2 (informational).** `PAGED_READ_MAX_ROWS` (200 000) pasa a ser por lote, así que el techo agregado de
  una lectura troceada es `200k × lotes`. Sigue fallando a la vista y nunca recorta en silencio.
- **F3 (informational).** `PagedReadError.requestedFrom` ahora es relativo al lote, no al conjunto. El
  mensaje sigue siendo accionable (tabla + `what`).

## Correcciones al diagnóstico inicial
- Dije que el troceo importaba porque "~100 turnos × conteos". **No es alcanzable por las rutas públicas
  de hoy**: `getDayView` corta en 50 turnos (`.limit(50)`, `service.ts:2328`) y `getHistory` en
  `HISTORY_PAGE_SIZE = 10` (`schemas.ts:318`), así que las listas de `cash_shift_id` no pasan de 50/10.
  Las palancas que sí superan 100 son la lista de `invoice_id` (≈600 en un día) y los ids de usuarios
  (101). Los sitios 1,2,3,4,5,7,9,10 quedan correctos-por-construcción, alcanzables solo con ≤50 ids.

## Sin verificar (declarado)
- PostgREST real: no hay base viva; el 414 y el techo de 1000 se validaron contra `paged.ts`, el doble en
  memoria y aritmética de tamaño de URL.
- Si `009`/`033` están aplicadas en el Supabase desplegado.
- Los tests por mutación del archivo (el análisis de dientes es por fixture + registro, no por mutar).

## Fuera de alcance (inventario, NO tocado)
`alerts/service.ts:95,199`, `inventory/service.ts:500,649`, `admin/service.ts:263`,
`payroll/service.ts:592,1306`. Medido solo en las rutas de caja: `getShiftReviews` filtra ≤50 ids cerrados,
por lo que hoy queda bajo el límite de URL. Son la misma familia y van como unidad aparte si el dueño
quiere cerrarlas.

## Next
Nada pendiente dentro de esta unidad. Falta la decisión del dueño: commitear (código + este doc) o dejarlo
en el árbol. `opencode.json` está modificado en el árbol **antes** de esta tarea y NO entra en el commit.