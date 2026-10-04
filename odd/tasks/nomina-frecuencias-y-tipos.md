# Nómina: tipos de empleado y frecuencias de pago

> **Corrección de rumbo (decisión del dueño 2026-10-01, registrada 2026-10-02).**
> La instalación es de **una sola sede, físicamente**. Esta unidad **no depended de
> nada multi sede y sigue igual**: su alcance es la frecuencia de pago, la fracción
> del fijo, la regla del mixto y el detalle de la liquidación. Lo único que se anota
> es que el solape de períodos y el piso de fechas pasan a evaluarse **por
> instalación**, sin cambio de comportamiento. Ver «Corrección de rumbo» al final.

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
  - **Nota 2026-10-02**: el discriminante era la sede mientras la columna
    `sede_id` existía. **Resuelto**: la `074_sede_less_constraints.sql` reescribió
    la restricción con sus dos elementos —la cadencia y el rango de días— y la
    `077_drop_sede_id.sql` borra la columna sin tocarla. Queda acotada a
    **instalación + frecuencia**, como estaba previsto.
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
  — **VIGENTE sin cambio**: con una sola sede la regla se cumple sola, y la
  frecuencia se sigue preguntando por empleado.
- La comisión se gana **solo con la factura Pagada** (ya implementado), y el pago
  inmediato también lo exige.
- **Primera nómina**: se resuelve con un mix entre el sistema y complemento manual;
  después, normal. Hoy es jueves y el primer domingo hay 4 días de desfase.

## Scope
Dentro:
- `employees.pay_frequency` (semanal | quincenal | mensual), preguntada en alta y edición.
- `payroll_periods.frequency`, con la guarda de solape acotada a sede + frecuencia
  (y, cuando se elimine la columna, a instalación + frecuencia).
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
  sigue garantizando la guarda, ahora acotada por frecuencia y, tras el borrado de
  la columna, por instalación.
- Nada de fechas ni plata hardcodeada en la UI.

## Tasks
- [x] F1 migración: `employees.pay_frequency`, `payroll_periods.frequency` y la guarda de solape acotada a sede + frecuencia
- [x] F2 empleados: preguntar y mostrar la frecuencia en alta y edición
- [x] F3 cálculo: fracción del fijo por frecuencia + regla del mixto (el mayor, comparado solo con porcentajes de servicios)
- [x] F4 períodos: elegir la frecuencia del período, y que el mínimo de fecha y la validación se evalúen por frecuencia
- [x] F5 primera nómina: rango corto y complemento manual, documentado
- [x] F6 detalle: modal con las facturas y vales de la liquidación, con detalle de cada una
- [ ] F7 gate completo + commits por unidad + push — sin marcar: el cierre de unidad vive
      en el gate de la rama, que sigue en curso con M3a

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
  — Con una sola sede, la frase es: **la instalación** puede tener un período
  semanal y uno mensual que se superponen en fechas, pero no dos del mismo ciclo.
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
- 2026-10-02: F1–F6 cerradas y subidas. La decisión de sede única no altera esta
  unidad: el único ajuste pendiente es que el solape y el piso de fechas se
  evalúan por instalación cuando se elimine la columna (M3c).

## Corrección de rumbo: la instalación es de UNA SOLA SEDE (dueño, 2026-10-01)

**Esta unidad no cambia.** Nada de lo que aquí se decidió dependía de que la
instalación tuviera varias sedes: las frecuencias son del empleado, la fracción del
fijo sale de la cadencia, la regla del mixto compara básicos con porcentajes de
servicios, y el detalle muestra las fuentes de la liquidación. Todo eso sigue igual.

Lo único que se registra:

- La guarda de solape (`ex_payroll_periods_no_overlap`) y el piso de fecha del
  período pasan a evaluarse **por instalación**, no por sede. Es el mismo
  comportamiento con un discriminante menos: la `074` reescribió el `EXCLUDE` con
  sus dos elementos y la `077_drop_sede_id.sql` —que elimina la columna de las
  veinte tablas de negocio— lo deja intacto.
- La migración de nómina no se toca por esta decisión.

El plan completo de la migración a sede única y su estado están en
`odd/tasks/plataforma-super-admin.md` («Corrección de rumbo y plan de sede única»).
Lo único de ese plan que roza a esta unidad es M3c: la
`077_drop_sede_id.sql`, última de la serie, que borra la columna y sus índices en
las **20 tablas de negocio**. El borrado físico viaja en esa migración, no en un
archivo encima de un squash aplastado: el dueño evaluó el squash a un solo archivo
y lo descartó, así que el historial de migraciones queda como está. La excepción
es `users.sede_id`, que sobrevive (ancla la cuenta a la instalación y alimenta
`session.sedeId`), y por eso `payroll_apply_atomic` pierde los tres predicados
`e.sede_id = p.sede_id` y las dos columnas de sede de `payroll_discount_carries`,
pero ninguna otra cosa de la nómina cambia.

## Next step
- Nada pendiente de esta unidad: F1–F6 cerradas. Lo que sigue es la rama, con la
  unidad M3a en curso y M3c (eliminación de la columna) más adelante.

## Route declaration
- Delegación a `gentle-ai-worker` por unidad, con superficies disjuntas.
- `payroll/service.ts`, `payroll/schemas.ts` y `payroll.test.ts` están tomados por
  WU2 (deuda de vales): F3 espera a que libere. F1 (SQL) puede ir antes.
