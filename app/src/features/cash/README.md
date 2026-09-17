# Módulo `cash` (reservado — T6)

Caja única multi-turno: varios turnos por día sin solape, apertura con base
encadenada (`opening_base` = `base_left` anterior), pagos contra turno abierto,
cierre con conteo obligatorio (esperado vs contado), base configurable con casos
400/200 y 300/150, base incompleta con observación obligatoria, vista del día
con acumulado, historial por fecha.

- Tablas (T6): `cash_registers`, `cash_shifts`, `payments`.
- PRD: §5.5 CAJ-01…06, §9.1, §10 Caja, plan paso 5 (§12).
