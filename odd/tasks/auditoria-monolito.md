# Auditoría del monolito `app/` — cinco dimensiones

## Alcance y método
Auditoría read-only del monolito desplegable `D:/u/orabella/app` (Next.js 15.5 App Router sobre Vercel serverless, datos por Supabase PostgREST). `API/` (.NET) y `front/` (Angular 21) quedan fuera: son legacy y no se despliegan.

Cinco auditorías independientes, delegadas y verificadas por el orquestador:
- **S1** seguridad de datos y rate limiting
- **S2** arquitectura, modularidad y reutilización
- **S3** modelación de la información y persistencia
- **S4** escalamiento y resiliencia
- **S5** estilos, tokens y adopción de shadcn

Regla aplicada: los hallazgos que exigen servicio pago o que limitan las pruebas quedan **diferidos con motivo**, por restricción explícita del usuario (cero sobrecostos de infraestructura, cero límites al testing).

## Convergencias entre auditorías independientes
Estas son las señales más fuertes: dos auditorías que no se vieron llegaron al mismo punto por caminos distintos.

| Punto | Quién lo encontró |
| --- | --- |
| `service_role` bypasea RLS y la app nunca usa el cliente con RLS | **S1 (F14) + S3 (núcleo)** |
| Los `.limit(N)` se usan como frontera de correctitud | **S3 (H4) + S4 (Riesgo 3)** |
| Cero idempotencia y sin tope de sobrepago de factura en la base | **S3 (C2, M4) + S4 (Riesgo 5)** |
| Escrituras de dinero no transaccionales con compensación que se traga errores | **S3 (H1) + S4 (Riesgo 4)** |
| `invoices-client.tsx` como god file / peor outlier de estilos | **S2 (F1) + S5 (97% de la paleta cruda)** |
| Helpers duplicados (`formatMoney` ×8, `toNumber` ×6, `ActionResult` ×8) | **S2 (F5) + S5 (WU3)** |
| Primitivos de UI evadidos (≥100 elementos crudos; 10 de 50 archivos los usan) | **S2 (F6) + S5** |

### Conflicto entre informes, resuelto
**S4 afirma que la aislación por sede está "backed by RLS". Es incorrecto.** S1 y S3 establecieron independientemente, con evidencia de código, que `createAdminClient()` usa `service_role` y bypasea RLS, y que el cliente con RLS (`server.ts:20-41`) **no lo importa ninguna feature**. S4 repitió la afirmación del README. **Se resuelve a favor de S1+S3**: RLS no es un control activo; la única barrera es `resolveSede` en código de aplicación. Consecuencia práctica: un solo guard olvidado es una brecha total — exactamente lo que fue F1.

## CRÍTICOS de dinero (verificados por el orquestador)

### C1 — El cierre de caja y los totales del día CUENTAN DOS VECES los pagos de factura
Verificado leyendo los tres sitios:
- `cash/service.ts:851-856` — el espejo inserta en `invoice_payments` **sin `cash_shift_id`**.
- `cash/service.ts:471-484` — todo `invoice_payments` con `cash_shift_id IS NULL` se atribuye al turno que **emitió** la factura (`invoices.cash_shift_id`). La variable se llama `legacy`: el código cree que limpia datos viejos mientras el espejo los crea.
- `cash/service.ts:1315` — `[...paymentsByShift, ...invoicePayMaps]`: suma **los dos ledgers**.

Impacto: cuando una cajera registra un pago con `invoice_id` en el mismo turno que emitió la factura, `expected_cash`, `ventas`, `efectivo` y el arqueo por método se inflan por ese monto. El turno aparece con un **sobrante de caja que no existe** y la venta del día queda mal. Dinero equivocado en producción, todos los días.
**Corrección al fix propuesto (verificada por el orquestador leyendo el mecanismo, no aceptada de la auditoría):** mandar `cash_shift_id` en el espejo **NO alcanza**. El cierre (`cash/service.ts:955-988`) suma `payments` **y además** `invoicePayments`, y su propio comentario confirma que fue deliberado: *"Facturas cobradas en este turno … suman al esperado y al arqueo por método, igual que `payments`"*. El autor creyó que eran conjuntos disjuntos y no lo son, porque `registerPayment` escribe en los dos. Mandar el turno solo mueve la fila del bucket "sin turno" al bucket directo, y el cierre la sigue sumando encima: **el doble conteo sobrevive.**

Fix real, con el ledger de registro ya decidido (ver decisiones abajo):
1. El espejo manda `cash_shift_id: shift.id` **y** `fee_percent`/`fee_amount` (esto último cierra también H2).
2. El cierre y la vista del día suman `invoice_payments` por turno **más** `payments` donde `invoice_id IS NULL`, en lugar de la unión a ciegas. Son tres lectores: `cash/service.ts:983` (cierre), `:1312` (vista del día) y `:1457` (historial).
3. Backfill de las filas con `cash_shift_id` nulo, cruzando contra `payments` para no dejar duplicados.
4. Que el camino de caja deje de escribir `payments` cuando viene `invoice_id`, para que el invariante no se pueda romper de nuevo.

### C2 — "Lo pagado nunca supera el total" vive solo en la aplicación, con lectura-y-escritura sin lock
`invoice_payments` solo tiene `CHECK (amount > 0)`; no hay trigger de tope. El único tope de ese tipo en el esquema es `trg_payroll_payments_cap` (`007:136-173`), que **protege nómina pero no facturas**. Dos `splitPayment`/`registerPayment` concurrentes leen el mismo `paid` y ambos insertan → sobrepago, y `status` pasa a `Pagada` sin re-verificar.
Fix: trigger `BEFORE INSERT` en `invoice_payments` espejando el de nómina, con lock sobre `invoices`.

### C3 — Nada ata los totales de la factura a sus ítems, impuestos o pagos
La única restricción es aritmética dentro de una fila (`019:36-46`). No hay constraint ni trigger que exija `subtotal = Σ invoice_items`, `tax = Σ invoice_taxes` ni `Σ invoice_payments ≤ total`. La limpieza ante fallo **se traga sus propios errores** (`billing/service.ts:775-777`), así que puede quedar una factura con `total > 0` y **cero ítems**, consumiendo un consecutivo.
Fix: triggers `AFTER` (o una RPC que emita en una transacción); que la limpieza fallida sea ruidosa, no silenciosa.

### C2 bis — no idempotencia (S3 M4 + S4 Riesgo 5)
Reenviar `POST /api/v1/invoices` reserva un **nuevo consecutivo** y escribe una segunda factura con su propia salida de stock y comisión. Doble clic = doble factura. Y un reintento de un pago parcial de nómina paga doble, porque el trigger limita el total pero no reconoce reintentos.

## Estructura (S2)
Arquitectura **real, no nominal**: 32 route handlers finos (27–103 líneas), ninguno toca la base; `shared → features` da 0 imports; envelope único; READMEs por feature. Eso se preserva.

Deuda medida:
- `invoices-client.tsx` **3053 líneas, un componente de ~2760**; `commissions` no tiene página propia y su UI vive adentro de ese archivo.
- `admin/service.ts`: 5 dominios, 579 líneas, **45 importadores** (un cambio de catálogo puede romper la autenticación). El propio código documenta el split diferido.
- God services: `payroll` 1682, `billing` 1665, `cash` 1490.
- `tokenOf` copiado en **29 de 32** handlers; `*ErrorResponse` en **30 de 32**; 7 clases de error, 8 `validationMessage`, 8 `toFailure`, 7 `sessionToken`, 8 guardas con el mismo cuerpo, 6 formas de actor.
- **50 imports cruzados entre features con ≥3 ciclos** (`admin↔auth`, `billing↔cash`, `billing↔commissions`) y nada que lo impida: `eslint.config.mjs` son 8 líneas sin `no-restricted-imports`.

## Datos (S3) — el resto
- **H1 sin transacciones**: cada acción de negocio es una secuencia de statements HTTP independientes (limitación de PostgREST). Abrir caja inserta turno y después conteos: un fallo intermedio deja un turno abierto sin conteos, y el índice único parcial **bloquea cualquier turno nuevo** — deadlock operativo.
- **H2 el recargo de tarjeta se corrompe** en el camino de caja: el espejo omite `fee_percent`/`fee_amount`, y `amount` es bruto mientras el saldo de la factura es neto → falso "sobrepago".
- **H3 el kardex solo está protegido en INSERT**: nada impide `UPDATE`/`DELETE` sobre `inventory_movements` ni una escritura directa de `stock_qty`.
- **H4 `.limit(200)`/`.limit(2000)` como frontera de correctitud**: pasado el tope, el guard "factura ya está en una nómina cerrada" **deja de funcionar en silencio** y se puede cambiar una línea cuya comisión ya se pagó.
- **H5 la comisión inmediata se puede pagar dos veces**, y el comentario de la migración afirma un `UNIQUE` que no existe.
- **H6 sin tipos generados de la base**: ~100 casts `as` sin verificar. Un renombre de columna no da error de compilación.
- **H7 el código sondea columnas en runtime**: se defiende de migraciones no aplicadas, así que **el esquema real es incognoscible desde el código**.
- **H8 el esquema no es reproducible**: 30 migraciones a mano, sin `supabase/config.toml`, el README todavía dice "001 → 008" y `test-bootstrap.sql` se corta en 010.

## Escalamiento y resiliencia (S4)
Runtime: **serverless sin pool TCP**; el costo es round trips × latencia.
1. **Cada request autenticado = 4 round trips + 1 escritura en fila caliente** (`sessions.last_activity_at` en cada request, dentro de `getSessionUser`, que llaman todos los guards).
2. **N+1 en la salida de stock**: factura de 10 productos ≈ 30 round trips secuenciales, después de que la factura ya existe.
3. **Nómina carga todo en memoria con truncado silencioso** y, sin `maxDuration`, puede morir por timeout.
4. Escrituras de dinero no transaccionales con compensación best-effort.
5. Endpoints de pago no idempotentes.
Además: **cero timeouts de salida** en ningún lado (un DB lento cuelga la función hasta que la plataforma la mate), sin reintentos, y **el health endpoint no verifica nada** (devuelve `{status:"ok"}` estático), así que un monitor no detecta una caída de base.
Sólido: `clampLimit` y lecturas acotadas por política, `next_invoice_number` con `FOR UPDATE`, guardrails en base, rate limiting real con backend externo y fallback documentado, caché de catálogos con `unstable_cache` + `revalidateTag`, y `writeAudit` que nunca lanza.

## Estilos (S5)
- **Los cuatro `-50` en claro eran acromáticos** → todo badge salía gris con texto de color. **Arreglado y verificado** (contraste 5.34–7.33:1 en ambos temas).
- 39 sitios de feedback interactivo como texto inline, **sin ningún mecanismo de toast**.
- La disparidad de color está **concentrada**: 155 de 159 hits de paleta cruda en `invoices-client.tsx`.
- Clases legacy sin capa que **ganan en la cascada** sobre las utilidades de Tailwind del mismo nombre. Probado en el CSS compilado: `.shadow-sm` existe dos veces en `@layer utilities` y una sin capa, y gana la del proyecto.
- Los `.text-primary`/`.bg-primary`/`.text-secondary` legacy están **muertos** (0 usos). Y los conteos previos de "41/22/64 usos" eran **artefactos de substring**: `text-text-primary` termina con `text-primary`.

## Plan unificado, por orden de daño
### Tramo 0 — dinero (no negociable, chico y crítico)
1. **C1**: `cash_shift_id` en el espejo + backfill de las filas NULL. Una línea + migración.
2. **C2**: trigger de tope en `invoice_payments` espejando el de nómina; `.eq("status","abierto")` en el UPDATE de cierre. **El índice único en `cash_shift_counts (shift_id, phase)` que yo propuse es IMPOSIBLE**: `insertCounts` (`cash/service.ts:484`) escribe una fila por método × denominación por fase, así que esa clave rechazaría la segunda fila de todo conteo real y rompería cada apertura y cada cierre. Descartado — ver T0-a.
3. **C3**: constraints o RPC transaccional para emisión; que la limpieza fallida sea ruidosa.
4. **H2**: pasar `fee_percent`/`fee_amount` por `registerPayment`; validar contra el bruto en ambos caminos.

### Tramo 1 — hot path y robustez
5. Recortar el camino caliente de sesión (no escribir `last_activity_at` en cada request; memoizar por request).
6. Timeouts de salida con `AbortSignal.timeout`.
7. Batch de la salida de stock en un insert + una relectura.
8. Que la nómina **falle ruidosamente** al tocar el tope de lectura.
9. Health endpoint que verifique de verdad (un `head`/`count` contra PostgREST).

### Tramo 2 — estructura
10. Kernel compartido (S2 F3+F4+F5): `AppError`, `requireRole`, `withSession`, `toFailure`/`sessionToken`/`validationMessage`. Borra ~600–800 líneas. **Desbloquea todo lo demás.**
11. Lint de fronteras (`no-restricted-imports`) para que los 50 imports cruzados no crezcan.
12. **WU-C1** (en curso): retirar clases muertas y registrar claves canónicas → **habilita el registry de shadcn**.
13. Split de `admin/service.ts` (el plan ya está escrito en el código).
14. Split de `invoices-client.tsx` en 6–8 archivos por flujo, encadenado.

### Tramo 3 — estilos y UX
15. `WU1` paleta cruda fuera de invoices-client · `WU2` combobox · `WU3` consolidar helpers · `WU4` adoptar `Badge`/`Alert` · `WU5` tokenizar el chrome de invoices-client, encadenado.
16. **WU-A/B/C** del frente de feedback: `Alert` para estado, toast (`sonner`) para eventos.

## T0-a — resultado (2026-10-01)
C1 y C2 corregidos y validados: `cash.test.ts` 48 → 63, suite 391 → **406**, typecheck y lint limpios.

### Y otra prescripción mía que era falsa
El índice único en `cash_shift_counts (shift_id, phase)` **habría roto cada apertura y cierre**: `insertCounts` escribe una fila por método × denominación por fase. El writer lo detectó, **no adivinó** y preguntó. Decisión tomada: **opción A — la migración 031 va sin ese índice**, porque el agujero de doble cierre ya está tapado por el `.eq("status","abierto")`, que es un compare-and-swap real (un segundo cierre afecta 0 filas → `PGRST116` → `SHIFT_ALREADY_CLOSED`). El índice correcto sería por línea (`shift_id, phase, method_code, coalesce(denomination, -1)`), pero cambiaría el comportamiento de la API (empezaría a rechazar líneas de denominación duplicadas que hoy acepta) y podría abortar la migración sobre duplicados históricos que no se pueden inspeccionar sin acceso a la base.

### Tres desviaciones del brief, todas con evidencia
1. **El tope de sobrepago opera sobre el NETO (`amount − fee_amount`) contra `invoices.total`, no sobre `sum(amount)`.** `amount` guarda el bruto (neto + recargo, `019_card_fee.sql`) y `splitPayment` exige `sum(neto) == saldo` pero guarda el bruto **sin** actualizar `invoices.total`. Un tope sobre el bruto habría rechazado un pago legítimo con tarjeta (neto 100.000 → fila 105.000 contra total 100.000). El invariante `sum(amount − fee_amount) ≤ total` se cumple en todos los caminos y sigue cortando la carrera. Es H2 entendido de verdad.
2. **La rama "legacy" de turno nulo se mantiene**, con prueba de disjunción (lee solo `cash_shift_id IS NULL`; los otros lectores solo no-nulos; todas las filas de `invoice_payments` son de factura por esquema; y los tres lectores de `payments` ahora filtran `invoice_id IS NULL`). El motivo de fondo no lo había considerado: **código y migración no despliegan atómicamente**, así que mantener la rama hace el arqueo correcto en los dos órdenes de despliegue. La migración la materializa, así que se puede borrar después.
3. **Se mantiene el write de `payments` con `invoice_id`**, tras inventariar los **5** lectores existentes en `src/` y probar que ninguno depende de esas filas. Retirarlo habría cambiado el contrato de retorno de `registerPayment` y la simetría del rollback.

### Residuales declarados
- La SQL **no fue ejecutada** (sin acceso a base). La garantía del trigger contra inserciones concurrentes depende del snapshot bajo READ COMMITTED, la misma suposición que ya usa el trigger de nómina — que, dato: **no tiene lock**, el nuevo sí. **Prerequisito de despliegue**: un experimento de dos sesiones antes de confiar en el tope como garantía dura.
- Sin índice de conteos, la unicidad de las filas de `cash_shift_counts` la protege solo el guard de estado.
- `src/features/cash/README.md` ya fue corregido en T0-a-fix.

### Huecos residuales de la verificación del fix (nombrados, no barridos)
1. **`if (!mirror)` sin compensación ni log** (`cash/service.ts:935`): si el insert del espejo tiene éxito pero no devuelve fila, queda el estado mirror-only **en silencio**, con un 500 genérico y un reintento que el tope después bloquea. Es del mismo tipo que el bug recién arreglado y cae en el mismo bloque que H2 → se arregla ahí.
2. **El tope solo dispara en INSERT**: `editEmittedInvoiceItems` puede **reducir `invoices.total`** en una factura `Emitida` con pagos parciales y dejarla sobre-cobrada sin que nada lo detecte, y a partir de ahí todo insert nuevo es rechazado. Es un hueco real de diseño y necesita **decisión de producto**: ¿editar el total debe bloquearse si ya hay cobros?
3. **Ventana de 1 centavo**: el split tolera `moneyEquals < 0.01` mientras el tope rechaza `> 0.009`; para excesos de un centavo la resta en float a veces da `< 0.01`, así que el servicio acepta y la base rechaza con 422. La divergencia va en dirección sobrepago: **no bloquea un pago exacto legítimo**.
4. **`amount` sub-centavo** en el camino de caja (`z.coerce.number().positive()`, sin `max` ni 2 decimales): el servicio redondea para comparar y la columna `numeric(12,2)` guarda el redondeo, produciendo un 422.

La verificación concluyó que **el tope no puede rechazar un pago legítimo exacto**: `F ≥ S` se cumple al formarse y solo aumenta, `S` se escribe en dos lugares y nunca se sube, y el exceso que produce un split aceptado es exactamente `S − F ≤ 0`. Eso era lo que importaba: un tope demasiado estricto bloquea una cajera a mitad de turno.

## H2 — resultado y residuales (2026-10-01)
Commit propio. Tres defectos del mismo bloque (`registerPayment`) mas la aritmetica de saldo que comparten: el recargo de tarjeta ahora llega al registro de cobro, el saldo es neto en caja **y** en facturacion, y el branch `if (!mirror)` compensa por id generado en la app y falla con codigo propio.

Verificacion independiente: **3.000.000 de flujos aleatorios, cero rechazos de pagos legitimos y cero divergencias servicio-vs-tope**. `splitGrossCardFee` probado por fuerza bruta contra `computeCardFees` sobre cada centavo hasta 1.000.000 con 14 porcentajes: inversa exacta. Y quedo arreglado, verificado, un bug pre-existente de facturacion que **rechazaba el abono legitimo** y marcaba `Pagada` con plata sin cobrar.

### Residuales
1. **Filas historicas con `fee_amount = 0`.** El camino de caja previo las escribio sin recargo, asi que **sobrestatan `netCollected` por el recargo**: pueden marcar `Pagada` con el recargo corto y decirle a un abono posterior que debe menos. Ni H2 ni 031 backfillean `fee_amount`. Necesita decision: backfill o residual aceptado.
2. **La linea "Pagado · Saldo" mezcla bases.** `paid` es bruto y `remaining` es neto, asi que una cajera que lea "Saldo 50000" y entregue 50000 con tarjeta deja 47619,05 de neto y **2.380,95 sin cubrir**. Atenuante: hoy **ningun llamador de la UI** usa `POST /api/v1/cash/payments` (verificado por grep), asi que muerde a la futura app REST, no a un operador actual. Decision de producto.
3. **La asercion acotada quedo mas debil.** El guard viejo prohibia cualquier `.delete()` entre el espejo y la fila de cajon; el nuevo se arma con `indexOf` y **pasa vacio** si `if (!mirror) {` llegara a preceder a `if (mirrorError) {`. Ademas afirma texto, no comportamiento. Reemplazo correcto: un test que mockee la cadena de `db` y afirme que no se emite delete cuando el insert falla. De los 13 tests nuevos de esa area, 7 son aserciones de texto sobre codigo defensivo inalcanzable.
4. Pre-existente y fuera de este cambio: una factura `Emitida` editada a la baja queda con `Saldo` clampeado a 0 y sigue `Emitida`; y una carrera de lectura-escritura entre dos cobros concurrentes puede dejar `Emitida` una factura ya cubierta.

## Decisiones del usuario pendientes (comprimen los fixes)
1. **RESUELTA (2026-10-01): `invoice_payments` es el ledger de registro; `payments` queda solo para movimientos SIN factura.** Razones: `invoice_payments` ya recibe filas de los dos caminos (`createInvoice` y el espejo), ya tiene las columnas de recargo de tarjeta (`019`) y ya es la fuente del saldo de la factura. Era la decisión raíz de C1 y resultó ser **prerrequisito duro**, no detalle de diseño final: sin ella el fix no se puede escribir.
2. **¿Una factura se puede borrar físicamente?** La limpieza ante fallo borra `invoices` y sus hijos. Si son artefactos fiscales, debe ser "anular con motivo".
3. **¿El dinero admite fracción?** COP se muestra con 0 decimales pero se guarda `numeric(12,2)`: define centavos vs decimales (M1) y si va un `CHECK`.
4. **¿Un turno cerrado es editable?** Hoy sí, sin re-contar, y contradice su propio conteo (M7).
5. **¿Un reintento de emisión es una factura nueva o se deduplica?** Define el contrato de idempotencia.
6. **¿Se invierte en RLS como defensa en profundidad, o se saca del modelo de amenaza?** Hoy es código muerto que da falsa tranquilidad.
7. **Upstash Redis** para rate limiting multi-instancia: **diferido por la restricción de cero sobrecostos**. Corrección al informe de S1: el bloqueo por cuenta (`locked_until`) es estado en BD, así que **sí** funciona entre instancias; lo que se pierde es el conteo fino de requests.
8. **Observabilidad** (Sentry/OTel) y **ejecución en background** de la nómina: requieren decisión de infraestructura, diferidos.

## Estado
- 2026-10-01: informe consolidado creado tras cerrar las cinco dimensiones. Hallazgos previos ya accionados: F1 de S1 (commit `3544ee4`), cabeceras F9 de S1 (`23cfb54`), endurEcimiento de tests (`fa74bb3`), croma de tokens y aliases (`5d4b6f8`).
