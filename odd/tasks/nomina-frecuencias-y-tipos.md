# Nómina: tipos de empleado y frecuencias de pago

## Objective
Que la nómina pueda liquidar correctamente a los tres tipos de empleado (fijo,
porcentaje y mixto) según la frecuencia de pago acordada con cada uno (semanal,
quincenal o mensual), y que al ver el detalle se puedan abrir las facturas y vales
que componen esa liquidación.

## Problem
Hoy la nómina no conoce la cadencia de pago: el fijo se prorratea por los días
reales de cada mes (`prorateFixedSalary`) y no existe la idea de "semanal paga
1/4, quincenal 1/2, mensual completo". Además:

- La restricción `ex_payroll_periods_no_overlap` (035) prohíbe dos períodos de la
  misma sede que compartan días. Con frecuencias distintas conviviendo en una sede
  eso se vuelve un bloqueo, porque el ciclo semanal y el mensual **se superponen
  a propósito**.
- El empleado no guarda su frecuencia de pago, así que no hay de dónde deducir la
  fracción del fijo.
- El tipo mixto no tiene regla: no está definido que se pague el MAYOR entre su
  básico del período y lo que generó por porcentaje.
- El detalle de la liquidación no permite llegar a las facturas y vales que la
  componen.

## Decisiones del dueño (2026-10-01)
- **Semanal = mensual / 4**, quincenal = mensual / 2, mensual = completo. Base
  contable de **30 días**, o sea el mes se cuenta como 4 semanas.
  - **Consecuencia aceptada y visible**: 1/4 por semana paga ≈ 13 sueldos al año
    (52,14 semanas), no 12. Con 1.500.000 son ≈ 19.500.000 al año. Se eligió así,
    con la advertencia sobre la mesa.
- **Mixto = el MAYOR** entre su básico del período y lo generado por porcentaje:
  básico 300.000 con 400.000 de porcentajes → 400.000; básico 300.000 con 200.000
  → 300.000.
- La comparación del básico es **solo contra los porcentajes de servicios**, no
  contra las comisiones fijas por producto.
- **Solo porcentaje**: sigue cobrando lo que genera.
- El total a pagar de todos los tipos considera comisiones, bonos, descuentos y
  vales (la identidad de `payroll_items` no cambia).
- **La sede es individual**: los empleados son exclusivos de una sede y, si se
  mueven a otra, se ajustan a cómo se trabaja ahí. La frecuencia se pregunta por
  empleado al crearlo o editarlo.
- La comisión se gana **solo con la factura Pagada** (ya implementado), y el pago
  inmediato también lo exige.
- **Primera nómina**: se resuelve con un mix entre el sistema y complemento manual;
  después, normal. Hoy es jueves y el primer domingo hay 4 días de desfase.

## Scope
Dentro:
- `employees.pay_frequency` (semanal | quincenal | mensual), preguntada en alta y edición.
- `payroll_periods.frequency`, con la guarda de solape acotada a sede + frecuencia.
- Cálculo de la fracción del fijo por frecuencia y regla del mixto.
- Períodos: la frecuencia del período decide a quién se le paga y con qué fracción.
- Detalle: modal con las facturas y vales de la liquidación, con detalle de cada una.
- Soporte explícito para la primera liquidación (rango corto + complemento manual).

Fuera:
- Tocar la identidad del `CHECK` de `payroll_items`.
- Cambiar el modelo de comisiones o el pago inmediato.
- Históricos: los períodos ya cerrados no se recalculan.

## Constraints
- Migración nueva; el dueño la aplica a mano en PRUEBAS.
- No se puede liquidar dos veces el mismo día **dentro del mismo ciclo**: eso lo
  sigue garantizando la guarda, ahora acotada por frecuencia.
- Nada de fechas ni plata hardcodeada en la UI.

## Tasks
- [ ] F1 migración: `employees.pay_frequency`, `payroll_periods.frequency` y la guarda de solape acotada a sede + frecuencia
- [ ] F2 empleados: preguntar y mostrar la frecuencia en alta y edición
- [ ] F3 cálculo: fracción del fijo por frecuencia + regla del mixto (el mayor, comparado solo con porcentajes de servicios)
- [ ] F4 períodos: elegir la frecuencia del período, y que el mínimo de fecha y la validación se evalúen por frecuencia
- [ ] F5 primera nómina: rango corto y complemento manual, documentado
- [ ] F6 detalle: modal con las facturas y vales de la liquidación, con detalle de cada una
- [ ] F7 gate completo + commits por unidad + push

## Authorized scope
Módulo de nómina (empleados, períodos, cálculo, detalle), migración nueva.
Rama `feat/orabella-mvp`.

## Acceptance
- Un empleado fijo semanal de 1.500.000 cobra 375.000 por semana; uno quincenal
  750.000; uno mensual 1.500.000.
- Un mixto con básico semanal 300.000 y 400.000 de porcentajes de servicios cobra
  400.000; con 200.000 cobra 300.000.
- Una sede puede tener un período semanal y uno mensual que se superponen en
  fechas, pero no dos del mismo ciclo.
- El total respeta la identidad de `payroll_items` en los tres tipos.
- Se puede abrir el detalle de una liquidación y ver sus facturas y vales, cada
  uno con su detalle.
- `npm run typecheck` 0 y suite completa sin regresiones.

## Checks
`npm run typecheck`, `npm test` (full), `next build`.

## Progress
- 2026-10-01: doc creado con las decisiones del dueño. Diseño fijado: frecuencia
  por empleado y por período, guarda de solape por sede + frecuencia, fracción del
  fijo por cadencia, mixto por el mayor. Pendiente: derivar F1.

## Next step
- F1 (migración) en cuanto se libere el clúster de nómina que está tomando el
  writer de la deuda de vales (`service.ts`, `schemas.ts`, `payroll.test.ts`).

## Route declaration
- Delegación a `gentle-ai-worker` por unidad, con superficies disjuntas.
- `payroll/service.ts`, `payroll/schemas.ts` y `payroll.test.ts` están tomados por
  WU2 (deuda de vales): F3 espera a que libere. F1 (SQL) puede ir antes.
