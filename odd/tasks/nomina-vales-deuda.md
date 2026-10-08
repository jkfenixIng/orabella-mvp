# Nómina: los vales son vales, y el sobrante es deuda del empleado

> **Corrección de rumbo (decisión del dueño 2026-10-01, registrada 2026-10-02).**
> La instalación es de **una sola sede, físicamente**. Esta unidad **no depende de
> nada multi sede y sigue igual**: el total real del vale, la deuda arrastrada y el
> marcado atómico se implementaron tal como se decidió aquí. Lo único que se anota
> es que la deuda, hoy acotada a sede + empleado, quedará acotada a instalación +
> empleado cuando se elimine la columna. Ver «Corrección de rumbo» al final.

## Objective
Que la columna de vales de la liquidación muestre **la suma real** de los vales del
empleado dentro del rango del período, y que el sobrante que hoy se pierde cuando el
vale supera lo ganado quede **como deuda del empleado** y se descuente en el período
siguiente.

## Problem
La tabla `payroll_items` impone la igualdad (con tolerancia de un centavo):

```
neto = fijo + comisiones + bonos − vales − otros
```

y `computeNetPay` tiene piso en cero (`Math.max(0, ...)`). Para que esa igualdad se
sostenga sin neto negativo, `capPayrollDiscounts` **recorta el vale al bruto** y ese
recorte es lo que se persiste y se muestra. Consecuencia medida:

- Un empleado con `pay_type = "porcentaje"` y sin bonos tiene `bruto === comisiones`.
- Un vale de 50.000 con bruto de 20.000 se persiste como `deductions_vales = 20.000`.
- La celda "Vales" muestra **exactamente la comisión**, porque es el bruto recortado.
  No es un cruce de columnas: la cadena (selección, suma, payload, SQL por nombre,
  alineación de las dos tablas) está verificada de punta a punta.
- El sobrante **no se recupera en ningún lado**: el vale queda `descontada` completo en
  la base, pero el exceso no pasa al período siguiente. Se pierde para el negocio.

## Decisiones del dueño (2026-10-01)
- **"Vales son vales y nada más"**: el campo debe mostrar la suma real de los vales, sin
  recorte, y sin parecerse a la comisión.
- **El sobrante se arrastra** como deuda del empleado al período siguiente (opción
  elegida sobre mostrar solo el recorte o permitir neto negativo).
- La comisión se gana **solo con facturas Pagada** (ya implementado), y el pago inmediato
  también lo exige (ya implementado).

## Scope
Dentro:
- Persistir el **total real de vales** del período por empleado (hoy solo se guarda el
  valor recortado).
- Persistir y **arrastrar el sobrante** como deuda del empleado de la sede.
  — Con una sola sede, la deuda es **de la instalación** y del empleado.
- La columna "Vales" muestra el total real; el neto sigue con piso en cero y no cambia la
  igualdad de la tabla.

Fuera:
- Cambiar la igualdad del `CHECK` de `payroll_items` (es la garantía de consistencia).
- Permitir neto negativo.
- Tocar el pago inmediato de comisión o la regla de facturas pagadas.
- Recalcular períodos cerrados (no se puede: `assertDraftPeriod`).

## Constraints
- Migración nueva (el dueño la aplica a mano en PRUEBAS; no hay runner).
- Sin cambios al `CHECK` de `payroll_items` ni al signo almacenado de los vales: la
deuda entrante se aplica al neto **dentro de `other_discounts`** (así la igualdad sigue
vigente sin tocarla) y su trazabilidad vive en la tabla de deudas, que registra en qué
período se aplicó.
- La deuda es por sede + empleado, y su origen debe ser trazable (de qué período salió).
  — **RESUELTO (2026-10-03)**: la columna se eliminó (M3c ejecutado), así que el índice quedó por
  **instalación + empleado**, sin cambio de comportamiento observable: una sola instalación, una
  deuda por empleado. El texto anterior describía el estado intermedio, cuando la columna todavía
  existía y el índice era `(sede_id, employee_id)`.
- Suite completa y `typecheck` en 0 antes de cerrar.

## Tasks
- [x] WU1 migración: columna `voucher_total` (total real, fuera de la igualdad) + tabla
  `payroll_discount_carries` + reemplazo de `payroll_apply_atomic` para persistir el total
  real y registrar el sobrante como deuda (SQL, idempotente)
- [x] WU2 cálculo: enviar el total real, aplicar la deuda entrante dentro de
  `other_discounts` y registrar el sobrante saliente
- [x] WU3 UI: la columna muestra el total real y la deuda pendiente queda visible
- [ ] WU4 gate completo + commits por unidad + push — sin marcar: el cierre de unidad vive
      en el gate de la rama, que sigue en curso con M3a

## Authorized scope
Nómina (liquidación), migración nueva, cálculo, persistencia y la columna de vales.
Rama `feat/orabella-mvp`.

## Acceptance
- Un empleado con vale de 50.000 y bruto de 20.000: la columna "Vales" muestra 50.000.
- Su neto no queda negativo y la igualdad de la tabla se mantiene.
- El sobrante de 30.000 queda registrado como deuda y aparece como descuento en el
  período siguiente.
- La deuda no se duplica si el período se recalcula.
- `npm run typecheck` 0 y suite completa sin regresiones.

## Checks
`npm run typecheck`, `npm test` (full), `next build`.

## Progress
- 2026-10-01: diagnóstico cerrado (era el recorte, no la columna). Doc creado con la
  decisión del dueño. Diseño fijado: el total real va en columna propia fuera de la
  igualdad, y la deuda entrante se aplica dentro de `other_discounts` para no tocar el
  `CHECK`. Pendiente: derivar WU1.
- 2026-10-02: WU1–WU3 cerradas y subidas. La decisión de sede única no altera esta
  unidad; el único ajuste pendiente es el índice de la deuda, que queda por
  instalación cuando se elimine la columna (M3c).

## Corrección de rumbo: la instalación es de UNA SOLA SEDE (dueño, 2026-10-01)

**Esta unidad no cambia.** Nada de lo que se decidió aquí dependía de que la
instalación tuviera varias sedes: el total real del vale vive en su propia columna
(`voucher_total`, fuera de la igualdad de `payroll_items`), la deuda entrante se
aplica dentro de `other_discounts` y el sobrante saliente se registra con su período
de origen. Todo eso se implementó tal cual y sigue vigente.

Lo único que se registra:

- **RESUELTO (2026-10-03)**: la columna se eliminó (M3c ejecutado) y el índice quedó por
  **instalación + empleado**, sin cambio de comportamiento observable. El texto anterior
  describía el estado intermedio, cuando la columna todavía existía.
- `voucher_settings` (topes de día y semana) tiene su propia unidad de reemplazo: el
  dueño eligió una tabla `system_settings` de clave/valor (M3b del plan de sede
  única). No toca el cálculo de esta unidad, pero conviene tenerlo presente al
  leer los topes.

El plan completo de la migración a sede única y su estado están en
`odd/tasks/plataforma-super-admin.md` («Corrección de rumbo y plan de sede única»).

## Next step
- Nada pendiente de esta unidad: WU1–WU3 cerradas. Lo que sigue es la rama, con la
  unidad M3a en curso y M3c (eliminación de la columna) más adelante.

## Route declaration
- Delegación a `gentle-ai-worker` por unidad, con superficies disjuntas.
- WU1 (SQL) puede ir en paralelo; WU2 y WU3 esperan a que se liberen
  `payroll-client.tsx` y `payroll.test.ts`.
