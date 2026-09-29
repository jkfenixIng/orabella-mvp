# Auditoría cruzada entre módulos (U4)

## Objective
Auditar las **interacciones** entre los módulos de `app/` —no cada módulo por dentro— porque los tres
defectos de dinero de esta ola vivieron exactamente en los bordes: el arqueo contaba dos veces los
cobros de factura, el recargo se perdía en el camino a caja, y el tope de sobrepago dejaba de funcionar
pasado un límite.

## Estado de los hallazgos (actualizado 2026-09-29)

| # | Hallazgo | Estado |
| --- | --- | --- |
| 1 | Truncamiento silencioso en el cálculo de nómina | **CERRADO** `e11b561` |
| 2 | El candado de nómina cerrada fallaba abierto | **CERRADO** `e11b561` |
| 3 | Anulación: comisión viva sobre factura anulada + doble restauración de stock | **CERRADO** `ea696b5` |
| 4 | `commission_payouts` sin tope en la base | **CERRADO** `7e89aa6` (migración `034`) |
| 5 | Transiciones de vale sin guarda de estado | **CERRADO** `e6b9c4f` |
| 6 | Pagos de nómina invisibles para el arqueo | **ABIERTO — decisión del dueño** (¿la nómina en efectivo sale del cajón?) |
| 7 | `commission_mode` sin consumidor | **ABIERTO — decisión del dueño** (¿el modo declarado manda o se elimina el campo?) |
| 8 | Cobros no idempotentes con compensación best-effort | **ABIERTO** (necesita claves naturales o RPC) |
| 9 | Deltas de stock sin lock en las ediciones | **ABIERTO** |
| 10 | Identidad con dos escritores y sin transacción | **ABIERTO** |
| 11 | La 032 referenciada sin existir | **CERRADO** `4975d5e` — el dueño dio de baja la reparación histórica y el borrador se eliminó |
| 12 | Columnas de entrada aceptan centavos | **ACEPTADO** — el histórico es de la era del centavo y la app no está en producción |

Familia de topes, cerrada en tres tandas: `e11b561` (nómina + candado), `868d037`
(`listEmployees(500)` --un empleado no se liquidaba--, reglas de comisión de la pantalla, `paid`/`remaining` de
período, marca `over_tope` que mentía) y `e6b9c4f` (el empleado 51 veía su nómina vacía; `countInvoices`
armaba una URL que en producción es un 414).

Huecos adyacentes **reportados y no tocados**, con su motivo: `trg_payroll_payments_cap` (`007`) no toma
lock de fila, así que `payroll_payments` puede tener la misma ventana que la 034 acaba de cerrar; y el
descuento de nómina todavía escribe con un `in(...)` sin lotes (`payroll/service.ts:919`), acotado por los
vales del período.

## Method
Read-only, sobre el árbol ya arreglado (HEAD `2baa716`). La matriz se levantó leyendo los imports y las
escrituras a tablas, no adivinando por nombres. Para cada par: quién llama a quién (`path:line`), el
contrato, si está **garantizado o solo esperado**, el hueco y a quién le pega. Sin propuestas de
arreglo: hallazgo = defecto + mecanismo + radio de daño.

## Hallazgos, ordenados por plata y luego por alcanzabilidad

### 1. Truncamiento silencioso dentro del cálculo de nómina — **el peor**
`payroll/service.ts` lee con topes usados como frontera de correctitud y **sin `order()`**: facturas
`.limit(2000)` (`:524`), ítems `.limit(5000)` (`:552`), reglas `.limit(5000)` (`:634`), vales
`.limit(2000)` (`:673`), pagos inmediatos `.limit(5000)` (`:718`), totales de vales `.limit(1000)`
(`:1231`). Ninguno avisa cuando toca el tope.
**Mecanismo:** `calculatePayroll` arma comisiones y descuentos de vales con lo que devolvieron esas
consultas. **Radio:** comisiones subcalculadas → **empleados pagados de menos**; topes de vales por día
y semana calculados sobre un conjunto truncado → **topes evadidos**. **Alcanzabilidad:** crecimiento
normal de la sede y un clic del admin. **Sin carrera.**

### 2. El candado de nómina en facturación falla abierto pasado un tope
`invoiceInClosedPayroll` (`billing/service.ts:1706`) lee `payroll_periods` `.limit(200)` (`:1712`) e
ítems de `payroll_items.detail_json` `.limit(2000)` (`:1720`), **sin `order()`**. Se llama en las dos
ediciones (`:1218`, `:1489`).
**Mecanismo:** pasado el tope devuelve `false` en silencio (sin error, sin aviso) → la guarda
`PAYROLL_LOCKED` no dispara. Segundo hueco: la clave es "alguna línea de `detail_json` tiene este
`invoice_id`", pero las líneas sin base de comisión nunca se escriben en `detail_json`
(`payroll/schemas.ts:244-292`), así que una factura sin línea comisionable es **invisible** al candado.
**Radio:** un admin puede re-preciar o re-asignar una factura cuya comisión ya se pagó en un período
cerrado; nómina y factura divergen sin reverso.

### 3. La anulación está fuera del candado de nómina y sin guarda de estado
`annulInvoice` (`billing/service.ts:1050-1100`) sólo mira `canAnnulStatus` (`:1062`), actualiza
`invoices` (`:1073`) y restaura stock (`:1089`). El candado de nómina que **sí** existe en las dos
ediciones (`:1218`, `:1489`) **no está acá**. Y el `UPDATE` de `:1073` no lleva `.eq("status", …)`,
mientras caja sí se lo puso al cierre (`cash/service.ts:1372`).
**Mecanismo (a):** la comisión ya pagada queda viva sobre una factura anulada, y nada la recupera: el
período cerrado está congelado y `commissions` sólo bloquea pagos inmediatos **nuevos** sobre una
anulada (`commissions/service.ts:177-185`). **(b):** dos anulaciones concurrentes leen `Pagada` y las
dos insertan el IN de stock → **stock restaurado dos veces**.
**Radio:** plata + stock. **(a)** una acción del admin; **(b)** doble clic.

### 4. `commission_payouts` no tiene tope en la base
`commissions/service.ts` lee el pendiente (`:304`) e inserta después (`:426`): lectura-y-escritura sin
lock, y esa tabla **no tiene trigger de tope**, a diferencia de `payroll_payments`
(`007_payroll.sql:142-174`) y `invoice_payments` (`031:160-215`).
**Mecanismo:** dos pagos concurrentes leen el mismo pendiente y cada uno inserta el total.
**Radio:** el empleado cobra dos veces; el arqueo registra las dos filas fielmente, así que el descuadre
cae en el cajón. Necesita carrera.

### 5. Las transiciones de vale no tienen guarda de estado
`approveVoucher` (`payroll/service.ts:1555`) y `rejectVoucher` (`:1651`) actualizan por `id` sin
guardar estado, mientras el descuento de nómina **sí** guarda (`:1067-1077`,
`.in("status", ["pendiente","aprobada"])`).
**Mecanismo:** un approve que corrió contra un descuento de nómina devuelve `descontada` a `aprobada`
→ el vale vuelve a ser descontable en un período posterior y queda contado como salida de caja para
siempre. **Radio:** doble descuento del mismo vale (se le paga de menos al empleado) o salida de caja
fantasma. Necesita carrera.

### 6. Los pagos de nómina son invisibles para el arqueo
`payroll/service.ts:903-938` escribe `payroll_payments` (con `method_code`, sin `cash_shift_id`: la
columna no existe, `007_payroll.sql:120-133`). En `cash/service.ts` **la tabla no se lee nunca**.
**Radio:** si un ítem de nómina se paga por "efectivo", ese dinero sale del cajón y **no aparece en
ningún arqueo**: el operador ve un faltante sin explicación. **Es inferencia, no verificado:** puede
ser deliberado que la nómina se pague fuera del cajón; si lo es, elegir "efectivo" como método es el
hueco. **Requiere decisión del dueño.**

### 7. `commission_mode` es un snapshot que nadie hace cumplir
Se escribe en la línea (`billing/schemas.ts:59-77`, inserts/updates en `billing/service.ts`) y **ningún
consumidor lo lee**: ni `commissions/service.ts:191` ni `payroll/service.ts:546` lo seleccionan.
Además `billing/schemas.ts:204-217` acepta combinaciones incoherentes (por ejemplo
`commission_mode: "porcentaje"` en un producto sin `commission_percent_override`), y la resolución
entonces paga la comisión fija del ítem o 0.
**Radio:** el **monto** no puede discrepar (hay una sola función que lo resuelve, eso está bien
resuelto), pero la pantalla puede decir "porcentaje" y la nómina pagar otra cosa, en silencio.
**Requiere decisión:** ¿el modo declarado manda, o se elimina el campo?

### 8. Escrituras de cobro no idempotentes con compensación best-effort
`invoice_payments` y `payments` se insertan por separado (`cash/service.ts:1078`, `:1140`;
`billing/service.ts:975`, `:1826`) sin clave natural única, y los rollbacks a mano reportan su propio
fallo pero dejan estado desconocido (`cash/service.ts:1095-1180`). Un reintento duplica el cobro.

### 9. Deltas de stock sin lock
`billing/service.ts:1363-1671` (edición de emitida) y `:1126-1330` (edición admin): leer y aplicar
deltas sin lock → dos ediciones concurrentes descuentan dos veces.

### 10. Identidad con dos escritores y sin transacción
`admin/service.ts:534-548` (borra e inserta roles), `:268-278` (crea `users`), y `auth/service.ts`
escribe las mismas tablas. Un fallo entre el delete y el insert deja al usuario **sin roles** → cada
guarda responde 403. No es plata.

### 11. La 032 existió como borrador y se dio de baja (resuelto el 2026-09-29)
`billing/service.ts` y `tests/money-rounding.test.ts` mencionaban una migración `032` como "la
reparación de centavos históricos", y el directorio saltaba 031 → 033: el borrador estaba en
`032_*.sql.draft` a propósito porque su gate H3 fue refutado por una verificación independiente.
**Resolución: el dueño dio de baja la reparación histórica** (la app no está en producción, así que
esas filas son datos de prueba descartables). El borrador se **eliminó** y las referencias que apuntaban
a una migración inexistente se limpiaron del código y de los tests. Hoy los comentarios dicen qué pasa
de verdad: los cuadres contra filas guardadas siguen al centavo (`round2`) y el saldo cobrable es peso
entero (`invoiceNetBalance`), así que una factura con centavos igual cierra.

### 12. Columnas de entrada de dinero aceptan centavos y la edición los reescribe
`unit_price`/`discount` (`billing/schemas.ts:147-148`), catálogo (`admin/schemas.ts:120,147`), y
`billing/service.ts:1509-1517` escribiendo `round2` en `surcharge`/`total`. La regla del peso entero
todavía no es universal **hacia atrás**: el histórico puede re-emitir centavos.

## Veredicto por invariante
1. **Un ledger por hecho — SOSTIENE** (código): los tres lectores de `payments` filtran
   `invoice_id IS NULL` (`cash/service.ts:1288, 1683, 1840`) y los tres escritores fijan
   `cash_shift_id` (`cash/service.ts:1078`, `billing/service.ts:975`, `:1826`). Sin datos no se puede
   confirmar que el histórico esté atribuido.
2. **Bruto contra neto — SOSTIENE** en todos los sitios de comparación leídos. Riesgo latente:
   `applyPaymentSplit` (`billing/schemas.ts:604-620`) todavía codifica la semántica mezclada vieja
   (`paid` vs `total`) y **no la usa producción**: sólo los tests.
3. **Peso entero — PARCIALMENTE ROTO.** Todo el dinero calculado pasa por `roundMoney`, pero no
   normalizan: `unit_price`/`discount` de línea tal como llegan, el dinero de catálogo, y
   `billing/service.ts:1509-1517` (justificado como reconciliación). Y conviven **tres tolerancias**:
   `MONEY_EPSILON` 0.01, `0.009` en TS y `0.009` en SQL.
4. **Escritores contra dueños — DELIBERADO, SIN GARANTÍA.** No hay ningún módulo que escriba una tabla
   de dinero ajena salvo el caso deliberado caja → factura. `users`/`user_roles`/`employees` tienen dos
   escritores (admin y auth) y eso no está documentado como contrato compartido.
5. **Topes como correctitud — ROTO.** Listados en los hallazgos 1 y 2.
6. **Sede — SOSTIENE hoy, sin red.** Toda consulta cruzada leída lleva `sede_id` o un padre ya
   verificado; `admin.getEmployee` e `inventory.getProduct` no filtran y dependen del llamador. No
   encontré una lectura cruzada alcanzable.
7. **Modos de comisión — ROTO** (hallazgo 7).
8. **Vales — PARCIALMENTE ROTO**: los conjuntos de caja (aprobados) y nómina (pendientes+aprobados)
   difieren por diseño y se acuerdan sólo por `approved_by`; lo roto son las transiciones sin guarda.
9. **Inventario — ARITMÉTICA SOSTIENE, CORRESPONDENCIA ROTA**: un solo escritor del stock (trigger),
   pero doble restauración, compensación de creación que se traga el error (`billing/service.ts:877-903`)
   y deltas sin lock.
10. **Idempotencia y carreras — ROTO**: sin claves naturales únicas y sin transacciones de varios
    statements (PostgREST es de un statement, ya anotado en `billing/service.ts:784-786`).

## Lo que NO se cubrió
- **Bloqueado por la regla de no tocar base:** qué filas existen (centavos históricos, cobros huérfanos,
  `cash_shift_id` nulo, cobros duplicados, pagos de comisión contra lo ganado) y qué migraciones están
  aplicadas en el entorno destino. El código ya prueba migraciones en runtime
  (`inventory/service.ts:115`, `cash/service.ts:401`, `payroll/service.ts:274,283`).
- **Leído sin analizar a fondo:** login/lockout de `auth`, `alerts` (mapeo y esquemas), CRUD de sedes y
  roles de `admin`, enriquecimiento de `listInvoices`, apertura/borrado de períodos de `payroll`,
  CRUD de reglas de `commissions`, y toda la UI salvo dos rutas de API.
- **Pares no examinados:** auth↔alertas, inventario↔alertas, inventario↔comisiones,
  nómina↔alertas más allá de `voucher.requested`, admin↔inventario, comisiones↔inventario.
- **No probado y marcado como tal:** el desajuste de claves comisiones↔nómina (matriz J: las dos claves
  son (factura, empleado) y (empleado)); se verificaron las dos claves pero no se pudo construir una
  divergencia de plata alcanzable sin datos.

## Qué se necesita para cerrar los huecos de datos
Una pasada read-only con: (a) conteos de `invoice_payments`/`payments` con turno nulo y claves
duplicadas; (b) `information_schema` para migraciones y constraints aplicados; (c) conteo de filas por
sede contra los topes 200/2000/5000; (d) `payroll_payments` por `method_code` para medir el hallazgo 6;
(e) transiciones de `voucher_requests` contra `audit_logs` para detectar la carrera del hallazgo 5.

## Next
- **Decisiones del dueño requeridas:** hallazgo 6 (¿la nómina se paga del cajón?) y hallazgo 7 (¿el
  modo declarado manda, o se elimina el campo?).
- **Sin decisión de negocio, son defectos:** 1, 2, 3, 4, 5, 9, 10, y la limpieza de
  `applyPaymentSplit` (invariante 2).
- Orden sugerido por radio de daño y alcanzabilidad: **1 y 2** (plata, sin carrera) → **3** →
  **5 y 4** → el resto.

## Route declaration
- Auditor read-only (`gentle-ai-explore`) sobre `2baa716`, sin propuestas de arreglo. Los arreglos son
  unidades aparte y van en serie con el camino de la plata.
