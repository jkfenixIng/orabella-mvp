# Política de topes COP — Fase 4

## Decisión

Los topes de factura, nómina, comisión y mínimo de caja comparan **pesos enteros**. Las entradas nuevas pasan por `copSchema`/`positiveCopSchema` y 005 impide que se persistan centavos. La aplicación decide con `src/shared/money/caps.ts`; SQL conserva la defensa física contra carreras.

## Filas históricas

No hay backfill ni cambio de tipo. Para una fila legacy con centavos, el predicado proyecta acumulado, entrada y tope con `round(...)`/`postgresNumericRound(...)` antes de comparar. Esta última replica `numeric round` de PostgreSQL: los medios se alejan de cero (`-0.5 → -1`, `0.5 → 1`). Así `-0.009`, `-0.01`, `-0.5`, `-1.5`, `0.009`, `0.01` y `0.5` tienen una regla explícita y la misma semántica en TypeScript y PostgreSQL.

La política no modifica el estado de aprobación ya persistido. 005 mantiene las actualizaciones no monetarias sobre filas legacy: un trigger solo valida la columna monetaria si cambió.

## Invariantes específicos

- **Factura:** compara el neto (`amount - fee_amount`) contra `round(total - surcharge)`. El reparto de tarjeta conserva `gross - fee = net`; 007 no recalcula ni cambia esos valores.
- **Nómina y comisión:** compara la suma pagada más el nuevo pago contra el neto/ganado redondeado. Conservan el bloqueo de la fila padre para concurrencia.
- **Caja:** el mínimo es `round(round(opening_base) * 0.5)` y compara saldo y salida en pesos enteros. El ledger físico conserva sus sumas; solo cambia la frontera de comparación.

## Evidencia

`tests/money-cap-policy.test.ts` prueba equivalencia PGlite TypeScript/SQL en las fronteras legacy. `npm run test:concurrency` carga 007 en PostgreSQL real y mantiene los escenarios de locks y topes.
