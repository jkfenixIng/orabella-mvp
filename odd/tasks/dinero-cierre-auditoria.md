# Dinero, cierre de caja y auditoría cruzada entre módulos

## Objective
Ejecutar, **en orden**, las cuatro unidades confirmadas por el usuario el 2026-09-29, que son la
respuesta operativa a las nueve decisiones pendientes de `odd/tasks/auditoria-monolito.md`:

1. **Regla del peso entero** en toda la aritmética de dinero + **backfill** del recargo de tarjeta
   histórico (migración `032`). Una sola unidad: comparten el criterio de redondeo.
2. **Gate de edición del total** de una factura que ya tiene cobros: avisar y pedir confirmación.
3. **Cierre de caja intocable** + corrección por **reconteo obligatorio**, dejando las dos versiones.
4. **Auditoría cruzada de interacciones entre módulos**, sobre el árbol ya arreglado.

## Problem
Los tres defectos de dinero que se encontraron en esta ola —el arqueo que contaba dos veces los cobros
de factura, el recargo de tarjeta que desaparecía del registro, y el guard que dejaba de funcionar
pasado un tope— **vivieron justamente en los bordes entre módulos**, donde ninguna auditoría por
módulo mira. De ahí que la unidad 4 exista y vaya al final: se audita el árbol arreglado, no el anterior.

## Regla de negocio (dato del dueño; NO se deduce del código)
La terminal de pagos **no acepta centavos**: el recargo de tarjeta se le pasa al cliente y el total que
el cliente paga **en la terminal es el monto redondeado a peso entero**. Por lo tanto **lo que el
sistema registra tiene que ser exactamente lo que la terminal cobra**. No es una tolerancia: es la
unidad del dinero. Si la app guarda `$1.666,65` y la terminal cobra `$1.667`, cada cobro con tarjeta
deja un peso de descuadre entre el registro y la realidad.

## Decisiones del usuario (2026-09-29)
| # | Tema | Decisión |
| --- | --- | --- |
| 1 | Cobros viejos con el recargo en blanco | **(a)** reparar, con vista previa revisable antes de aplicar |
| 2 | Bajar el total de una factura con cobros | **la B**: permitir, avisando y pidiendo confirmación |
| 3 | Cerrar la caja y después cambiar el conteo | intocable + **reconteo obligatorio**, con doble versión guardada |
| 4 | ¿Existe la fracción de peso? | pesos enteros; y por el dato de la terminal, **redondea todo** |
| 5 | Hora en pantalla (huso del navegador) | **(b)** dejarlo como está |
| 6 | Dos recetas de sombra con el mismo nombre | que gane la del proyecto (variante: mapear los valores del proyecto como oficiales) |
| 7 | WU5: 224 clases crudas en `invoices-client.tsx` | rama y PR propios |
| 8 | RLS en el modelo de seguridad | **(b)** sacarlo del modelo y dejarlo escrito |
| 9 | Limpieza (docs alimentando el bundle CSS + `--bg-surface-2`) | revisar y dejar limpio, **sin sobreanálisis** |

## Orden confirmado
- **Antes del merge:** unidades **1 → 2 → 3** (son el mismo camino de la plata).
- **Al final, sobre el árbol arreglado:** unidad **4**.
- **Después del merge:** decisiones **5 a 9** (documentación y limpieza; no bloquean nada).

El redondeo va primero por una razón aritmética, no de gusto: el backfill del recargo calcula cuánto
recargo correspondía en cada cobro viejo, y con la regla del peso entero ese cálculo debe redondear con
la misma regla. Hacer el backfill antes escribiría datos con centavos que después habría que corregir.

## Scope
Touched (por unidad; a confirmar al abrir cada una):
- **U1:** `app/src/features/billing/schemas.ts`, `app/src/features/billing/service.ts`,
  `app/src/features/cash/service.ts`, `app/src/features/payroll/service.ts`,
  `app/src/features/commissions/service.ts`, `app/supabase/migrations/032_*.sql`,
  `app/tests/{money-rounding,billing,cash}.test.ts`
- **U2:** `app/src/features/billing/{service,schemas,actions}.ts`, `app/app/invoices/invoices-client.tsx`, tests
- **U3:** `app/src/features/cash/*`, `app/supabase/migrations/033_*` (a definir), tests
- **U4:** solo lectura sobre todo `app/` (matriz de interacciones, con `path:line`)
Out:
- `API/` (.NET) y `front/` (Angular): legacy, no se despliegan.
- Cálculo de nómina y contratos, impuestos, métodos de pago, auth, reportes, multi-sede, la hoja de
  factura impresa (excepción de diseño ya aceptada).

## Constraints
- **Escritura single-threaded:** un writer por unidad. Las unidades 1, 2 y 3 comparten el camino de la
  plata → **EN SERIE**, nunca en paralelo.
- **Nunca ejecutar SQL de escritura:** el MCP de Supabase apunta a PRODUCCIÓN. Las migraciones se
  escriben, no se ejecutan.
- Verificación por unidad desde `app/`: `npm run typecheck`, `npx eslint`, `npm test`.
- Un commit por unidad de trabajo en `feat/orabella-mvp`, sin push.
- Nunca inventar una regla de negocio que toque plata.

## Tasks
- [ ] **U1** Regla del peso entero + reparación revisable de la plata histórica (migración `032`, **rediseñada**)
  - Estado: **EN CURSO / rediseño**. La aritmética y los tests están hechos y verificados. La migración
    quedó **en borrador inerte** (`app/supabase/migrations/032_whole_peso_and_fee_backfill.sql.draft`)
    porque su gate H3 fue **refutado**: ver la verificación independiente abajo. **No aplicar.**
- [ ] **U2** Gate de edición del total con cobros: aviso + confirmación (decisión 2, opción B).
- [ ] **U3** Cierre de caja intocable + reconteo obligatorio con doble versión (decisión 3).
- [ ] **U4** Auditoría cruzada entre módulos (decisión del usuario, 2026-09-29): matriz de pares
  (facturas↔nómina, caja↔vales, nómina↔vales, facturas↔comisiones, caja↔facturas, inventario↔facturas…),
  contrato entre cada par, **si está garantizado o solo se espera**, y dónde está el hueco.
- [ ] **D5** Hora en pantalla: dejar como está, con la nota escrita (decisión 5).
- [ ] **D6** Sombras: los valores del proyecto como oficiales (decisión 6).
- [ ] **D7** WU5: sacar la paleta cruda de `invoices-client.tsx`, rama y PR propios (decisión 7).
- [ ] **D8** Sacar RLS del modelo de amenaza y documentarlo (decisión 8).
- [ ] **D9** Limpieza: acotar el escaneo de candidatos de Tailwind (hoy lee `odd/**/*.md`, así que la
  documentación alimenta el bundle CSS y contamina la evidencia) + retirar el `--bg-surface-2`
  duplicado (decisión 9).

## Evidence
### U1 — evidencia ya verificada (2026-09-29)
- `roundMoney` pasa de `Math.round(value * 100) / 100` a `Math.round(value)` (peso entero), con el
  porqué de negocio escrito en el código (`app/src/features/billing/schemas.ts:94-118`).
- `splitGrossCardFee` normaliza el bruto a peso entero y saca el recargo **por diferencia**
  (`fee = whole − net`), de modo que `net + fee === whole` es exacto y `amount − fee_amount` sigue
  siendo el neto que leen `invoiceNetBalance` y el tope de la migración 031.
- Cuatro módulos alineados: billing, caja, nómina y comisiones.
- `app/tests/money-rounding.test.ts` (26 tests) con **control negativo medido**: al revertir
  `roundMoney` al centavo fallan **20 de 26**; el archivo quedó idéntico al respaldo tras la prueba.
- Suite completa en verde: **27 archivos / 651 tests**. `npm run typecheck` limpio.

### Estado del árbol al abrir esta unidad
- HEAD `9c58391` (`feat/orabella-mvp`).
- Ajenos a este lote y **excluidos del commit**: `opencode.json` (regenerado por gentle-ai),
  `.codegraph/` y `.gentle-ai-default-agent.json` (sin trackear).
- `app/tests/money-rounding.test.ts` es nuevo y todavía sin trackear.

## Verification evidence
- **U1 (parcial):** `npm run typecheck` 0 · `npm test` 651/651 (27 archivos) · control negativo 20/26
  fallando al revertir el redondeo · `git status` confirma que ningún archivo quedó con residuo del
  experimento.

### U1 — verificación independiente (2026-09-29): el gate H3 quedó REFUTADO
Lo que cambia el diseño:

1. **El backfill no repara nada y puede escribir un recargo falso.** El archivo gateaba la escritura en
   `|E − F| < 0.01` creyendo que eso probaba que `amount` era el bruto. En los datos que escribe la app,
   `E ≡ Σamount − total`, así que el gate dispara **solo** cuando `total = Σamount − F`. Las filas del
   defecto (caja pre-`7b16604`) no pueden cumplirlo: el guard
   `incoming = roundMoney(invoicePaid + input.amount); if (incoming − invoiceTotal > 0.009) throw
   OVERPAID` (verificado en `7b16604^:cash/service.ts:900-902`, con `detail.paid` = suma de brutos)
   mantuvo `Σamount ≤ total`. Medido: **0 disparos y 0 recuperaciones** en 20.000 facturas por cada
   forma realista (pago completo al emitir, pago posterior por caja, parcial con tarjeta, mixto
   efectivo+tarjeta, dos filas de tarjeta). La única forma de hacerlo disparar es un
   `editEmittedInvoiceItems` que baje `total` justo hasta `Σamount − F`: ahí el UPDATE inventa un
   recargo que el cliente nunca pagó como recargo y deja `Σ fee_amount > invoices.surcharge`.
2. **Las constraints (c) probablemente nunca se crean.** La app redondeaba a **centavos** hasta este
   cambio, así que la plata histórica trae centavos (p. ej. 3 × 3333,33 = 9999,99). El censo (a2) los
   va a encontrar y entonces (c) responde `RAISE WARNING` y no crea ningún CHECK: esa mitad entrega cero.
3. **Defecto NUEVO de código, del cambio de redondeo (no del SQL).**
   `invoiceNetBalance.netRemaining` usa `round2` (centavos) mientras `netSum` es ahora siempre entero,
   así que **cualquier centavo histórico en `total`/`surcharge`/`amount` vuelve inalcanzable la
   igualdad exacta**: una factura `Emitida` con resto en centavos queda **impagable y sin poder
   cerrarse** (antes sí se podía). Es de la misma familia que los otros tres bugs de esta ola y hay
   que cerrarlo con la unidad.
4. **Los 6 asertos cambiados son legítimos**, no debilitados. Y el parseo real con `libpg_query`
   (`pgsql-parser`, PG 18) da OK en los 7 statements y en el cuerpo PL/pgSQL completo; los 27 pares
   (tabla, columna) existen en el DDL, y (a2) y (c) tienen la misma lista en el mismo orden.
5. Precisión sobre el verificador, que también hay que verificar: dio por invariante universal
   `invoices.surcharge = Σ fee_amount`. **No es universal**: `surcharge` solo se escribe al emitir
   (`billing/service.ts:894,1004`) y se conserva al editar (`:1487,1605`), pero un cobro posterior con
   tarjeta suma `fee_amount` sin tocar `surcharge`. Su conclusión sobre el gate se sostiene igual,
   porque se apoya en el guard, no en ese invariante.

### Diseño corregido de U1 (propuesto)
El usuario ya eligió, para los cobros viejos, "(a) reparar con una corrección de datos **revisable**".
Esa es la medicina correcta para los tres hallazgos y un heurístico aritmético no la reemplaza:

1. **Vista previa (solo lectura):** censo de centavos (a2), candidatos de recargo **con su `created_at`**
   (para ver la era de cada fila) e impacto por factura.
2. **Corrección revisable de los centavos históricos** a peso entero, con vista previa fila por fila del
   cambio. Esto además **quita el defecto 3** y **habilita (c)**.
3. **Recién entonces (c)** las constraints de peso entero, que pasan a tener sentido.
4. **El recargo histórico:** reparación por **lista revisada** (o por era con una fecha explícita), no
   por heurístico aritmético.

## Next step
- U1: el archivo está en **borrador inerte y NO se aplica**. Corregir su encabezado (la afirmación H3 es
  falsa y engañaría al próximo lector) y rediseñar (b)/(c) según el diseño corregido de arriba.
- Conseguir el connection string de **PRUEBAS** para correr la vista previa y **reemplazar la inferencia
  por números**. Es el desbloqueo real: todo el diseño depende de esos conteos.
- **No commitear U1** hasta que el diseño corregido esté verificado.
- Seguir con U2 (gate del total con cobros) y U3 (cierre intocable), en serie.
- U4 al final, sobre el árbol arreglado.

## Route declaration
- Delegación a un writer por unidad (`gentle-ai-worker`) y verificación independiente
  (`gentle-ai-verify`) antes de cada commit.
- Las unidades 1, 2 y 3 NO se paralelizan: comparten el camino de la plata.
- Nota operativa aprendida: un writer en background **muere con la sesión que lo lanzó**. Por eso el
  plan vive acá y cada unidad se commitea al cerrarse, para que una caída de sesión no pierda más que
  la unidad en vuelo.
