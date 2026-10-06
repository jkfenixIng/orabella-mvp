# Nómina: que el liquidador se pueda usar — desbloquear las cadencias y hacerlas visibles

## Objective

Que la pantalla de nómina deje de mentir por omisión. Hoy ofrece liquidaciones que **no se pueden
abrir**, muestra **tres períodos idénticos** sin decir a qué cadencia pertenece cada uno, y no deja
mirar un grupo sin arrastrar los otros dos.

Tres arreglos, en orden de dependencia:

1. **El índice de borradores ignora la cadencia** y hace imposible abrir 2 de cada 3 cadencias.
2. **La cadencia no se muestra en ninguna lista de períodos** (ni en la principal, ni en el
   diálogo), así que tres períodos del mismo rango son tres filas indistinguibles.
3. **No se puede filtrar por cadencia**, así que un ciclo que no le toca a nadie le sigue ocupando
   lugar en pantalla.

## Problem — medido contra los datos reales de PRUEBAS

Planta de 10 empleados activos en tres cadencias:

| Cadencia | Empleados |
| --- | --- |
| semanal | Carolina Rojas, Andrés Quintero, Lucía Herrera |
| quincenal | Diego Mejía, Marco Ospina, Paola Cifuentes |
| mensual | Elena Vargas, Sonia Morales, Natalia Pardo, Jorge Ramírez |

Existe **un** período: `semanal`, `2026-09-27 → 2026-10-03`, `borrador`. Ese período fija el piso
global en `2026-09-27`.

Corrida de `pendingPayrollSettlements` con esos datos y `referenceDate = 2026-10-05`:

```
Ciclo quincenal  2026-09-27 → 2026-10-03   "27 sep – 3 oct 2026"
Ciclo mensual    2026-09-27 → 2026-10-03   "27 sep – 3 oct 2026"
```

**Los dos pendientes tienen el mismo rango, carácter por carácter.** Abrir cualquiera de los dos
contra la base real devuelve `23505`, mapeado a `PERIOD_DRAFT_EXISTS`: el período semanal ya ocupa
`(2026-09-27, 2026-10-03)`.

### Por qué coinciden: la grilla cierra para todos el mismo sábado

`PAY_CYCLE_CALENDAR_DAYS = { semanal: 7, quincenal: 14, mensual: 28 }`, y todo ciclo cierra en
sábado (`saturdayOnOrBefore`). El primer ciclo de cada cadencia se **recorta** al piso
(`max(piso, inicioDelCiclo)`), y como **las tres cadencias cierran el mismo sábado**, toda cadencia
cuyo ciclo contenga el piso produce `(piso, últimoSábado)`. No es un caso raro: **con dos o más
cadencias, la primera liquidación ofrece siempre N rangos idénticos.**

### La contradicción entre dos restricciones

| Restricción | Qué prohíbe |
| --- | --- |
| `ex_payroll_periods_no_overlap` — `001_orabella_schema.sql:6456` | días compartidos **dentro de la misma cadencia** (`coalesce(frequency, '')`) |
| `uq_payroll_draft_per_range` — `001_orabella_schema.sql:7163` | igual `(start_date, end_date)` — **sin mirar la cadencia** |

La segunda anula a la primera.

### Forense: la cadencia NUNCA estuvo en ese índice

| Migración | Definición |
| --- | --- |
| 007 (original) | `(sede_id, start_date, end_date) WHERE status='borrador'` |
| 074 | `(start_date, end_date) WHERE status='borrador'` — se le quitó `sede_id` |

La 074 sacó `sede_id` (nulable, no participaba de la comparación) y la cadencia no se repuso. El
defecto estuvo **dormido** hasta el 2026-10-04: hasta el seed de humo **sólo Andrés tenía cadencia**
(`pay_frequency` era NULL en 9 de 10). Con una sola cadencia la colisión no se puede expresar.

### El apilamiento no es un artefacto: es un ritmo estructural

Medido: el semanal cierra cada sábado, el quincenal cada 2 y el mensual cada 4.

| Sábado | Qué vence |
| --- | --- |
| 10-oct | semanal |
| 17-oct | semanal + quincenal |
| 24-oct | semanal |
| 31-oct | semanal + quincenal + mensual |
| 14-nov | semanal + quincenal |
| 28-nov | semanal + quincenal + mensual |

**El quincenal y el mensual siempre coinciden**, porque 28 es múltiplo de 14 y los dos están clavados
a la misma grilla de sábados. Cada 4 sábados vencen los tres, para siempre. Es consecuencia directa
de anclar todo al sábado.

## Decisiones del dueño

### 1. El recorte del primer ciclo SE MANTIENE (2026-10-05)

El primer ciclo paga sólo desde el arranque del sistema: nadie cobra días sin evidencia. La
consecuencia aceptada es que la primera liquidación paga un sueldo corto (el mensual cobra 7 de 28
días) y que **los rangos siguen coincidiendo** — por eso el índice sin cadencia hay que arreglarlo,
y por eso el arranque corto hay que **decirlo en pantalla**.

Se descartó la alternativa (ciclo completo por cadencia), que habría hecho que el primer mensual se
remontara hasta 28 días antes de la primera evidencia.

### 2. La grilla se queda en sábado (2026-10-05)

El anclaje no se mueve de la grilla domingo→sábado.

### 3. La lista se filtra por pestañas de cadencia (2026-10-05)

`Todas | semanal | quincenal | mensual`, y **arranca en la cadencia que tiene algo pendiente**. La
cadencia además se rotula **en cada fila**, porque dentro de "Todas" tres períodos del mismo rango
siguen siendo indistinguibles por el solo hecho de tener pestañas.

## Fuera de alcance (deferido, no descartado)

**El anclaje por cadencia** («¿ya se pagaron los sueldos de este grupo? ¿hasta qué día?»). Con las
decisiones 1 y 2 —recorte y grilla compartida— las cadencias siguen compartiendo línea de tiempo, así
que el anclaje ya no separa nada: sólo serviría para declarar historia anterior al sistema, que el
dueño no pidió. Queda escrito en `mem_save` por si aparece la necesidad.

## Fuera de alcance (definitivo)

- Mover la grilla fuera del sábado.
- Recalcular períodos cerrados (`assertDraftPeriod`).
- Cambiar la regla de comisión por porcentaje o el pago inmediato.

## Tareas

- [ ] **T1** — Migración `078`: `uq_payroll_draft_per_range` consciente de cadencia. Sin esto, la
  quincenal y la mensual no se pueden abrir. Superficie: `schema-history/078_*.sql`,
  `supabase/test-bootstrap.sql`, `tests/atomic-guards.test.ts`.
- [ ] **T4** — Pestañas por cadencia + la cadencia rotulada en cada fila, en la lista principal y en
  el diálogo. La lista deja de mostrar fechas ISO crudas.
- [ ] **T5** — Copy: el primer ciclo recortado se explica, y el aviso de pendientes dice que cada
  cadencia es un grupo aparte que se liquida por separado.

## Fuera de mis manos

**La migración la aplica el dueño a mano** en el editor SQL de Supabase (no hay runner en el repo y
Supabase no permite DDL desde el cliente):

```sql
DROP INDEX IF EXISTS public.uq_payroll_draft_per_range;
CREATE UNIQUE INDEX uq_payroll_draft_per_range
  ON public.payroll_periods
  USING btree (start_date, end_date, coalesce(frequency, ''))
  WHERE (status = 'borrador');
```

## Riesgos

- **Techo de 3 ciclos por cadencia.** Si el dueño no liquida, el aviso llega a 9 entradas. Las
  pestañas no lo reducen: reducen lo que ocupa lugar a la vez, no el total.
- **Un arranque corto se ve como un error.** El primer ciclo paga el 25% del mensual. Sin la
  explicación de T5, se lee como un defecto de cálculo.
