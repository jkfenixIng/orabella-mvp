# Ajustes pre-pruebas: BD, comisiones N/A y alta automática usuario-empleado

## Objective
Dejar el proyecto listo para pruebas funcionales: BD endurecida y coherente, comisiones opcionales con estado No aplica, y alta de empleado que siempre crea su usuario de acceso sin pedir creación manual.

## Problem
- BD con 2 tablas sin RLS (`cash_shift_counts`, `cash_denominations`) y políticas abiertas en comisiones (`USING(true)`). Riesgo de exposición y consumo sin control.
- Comisiones se asumen siempre: se pide cobro en nómina o inmediato aunque el empleado no gane comisiones. Falta estado No aplica.
- Alta de empleado solo vincula usuario existente por documento; si no existe queda `user_id null` y el operador debe ir a otra pantalla a crear el usuario manual.

## Why
Sin esto las pruebas funcionales fallan en tres frentes: seguridad/consumo de BD, nómina con doble pago o cobros indebidos, y fricción operativa (crear empleado y luego usuario por separado).

## Scope
Touched:
- `app/supabase/migrations/017_*` (RLS + elegibilidad comisión si requiere DDL)
- `app/src/features/admin/service|schemas|actions` (auto-creación usuario + rol empleado por defecto)
- `app/app/admin/admin-tabs.tsx` + `app/app/admin/page.tsx` (quitar flujo manual de crear usuario, selector pasa a informativo)
- `app/src/features/commissions/service|schemas|actions` (guard No aplica + tope ganado-pagado)
- `app/src/features/payroll/*` (calculate + pay respetan No aplica, detalle ganado/inmediato/pendiente o N/A)
- `app/src/features/billing/*` (integración pendiente `no_commission` por línea, ya existe columna en 016)
- `app/src/features/cash/service` (expected descuenta payouts, ya existe; verificar con N/A)
- `tests/admin.test.ts`, `tests/payroll.test.ts`, `tests/commissions*` + bootstrap/seeds
Out:
- Facturación electrónica, multi-sede activa, agenda, reportes Excel, PWA.
- Reorganización grande de carpetas o cambio de stack.

## Constraints
- `sede_id` + UUID + `created_at/updated_at` en toda tabla de negocio; RLS deny-by-default; `service_role` solo servidor.
- Validación Zod en servidor en toda escritura; UI solo ayuda visual.
- Un solo turno abierto por caja; cierre exige conteo; base incompleta exige observación.
- Empleado: `employee_code` vacío repetible, con valor único por sede.
- Convención de commits: Conventional Commits en español neutro técnico, sin atribución IA.

## Tasks
- [x] DB1 Revisión BD entidades y consumo (route: direct-inline fallback, trigger: mapping 4+ files pero task-runner no disponible) — auditado RLS, índices, FK polimórficas. Entregable: `017_hardening_round2.sql` aplicado.
- [x] DB2 Endurecer RLS crítico — habilitado RLS en `cash_shift_counts`, `cash_denominations` y cerradas `commission_rules/payouts` por sede. Migración aplicada con éxito. RLS-disabled ERROR en 0.
- [x] COM1 Comisiones No aplica — backend: `payout_mode` admite `no_aplica` (schema+017), `payCommissionNow` bloquea con `COMMISSION_NOT_APPLICABLE`.
- [x] COM2 Nómina respeta N/A + resta inmediato — calculate filtra `no_commission` y nulos, N/A en 0 sin detalle, resta inmediato por factura del rango (clamp 0).
- [x] COM3 Facturación `no_commission` por línea — schema acepta flag e insert lo persiste; nómina lo excluye. Pendiente toggle UI en diálogo de factura.
- [x] USR1 Alta automática usuario al crear empleado — backend: si no hay `users` con `sede_id+documento`, crea usuario (clave=documento, `must_change_password=true`, `id_type=CC`) + rol empleado si queda sin roles. Nunca pide creación manual.
- [x] USR2 UI sin fricción — pestaña Usuarios sin botón Nuevo usuario; nota de alta automática. Solo roles y reset.
- [x] VER Verificación — `npm run typecheck`, `npm test`, `next build`, advisors. Evidencia abajo.
- [x] ARQ1 Guardas de sede/rol a shared — `resolveSede`+`requireSedeRole` viven en `src/shared/lib/sede.ts`; `admin/service` los re-exporta (misma identidad); 21 importadores migrados. Seguimiento: guardas de sesión y deps de datos entre servicios.

## Acceptance
- BD: 0 tablas de negocio sin RLS; advisors sin critical abierto o con decisión registrada; listados con límite y sin N+1 evidente.
- Comisión N/A: empleado sin acuerdo no muestra cobro; intentar payout inmediato devuelve N/A; nómina lo liquida en 0 con etiqueta N/A y reporte lo explica.
- Empleado con acuerdo: regla por (ítem×empleado) gana a tasa plana; `no_commission` gana 0; inmediato resta en nómina sin doble pago.
- Usuario-empleado: crear empleado crea usuario y rol empleado automáticamente; jamás se pide crear usuario manual; editar empleado sin usuario crea acceso en el mismo flujo.
- Pruebas F1-F4 del PRD pasan en local antes de subir.

## Checks
`npm run typecheck`, `eslint` en archivos tocados, `npm test`, `next build`, Supabase advisors.

## Progress
- 2026-09-22: documento creado desde revisión pre-pruebas + requisitos DB/comisiones-N/A/auto-usuario. Sin código tocado.

## Verification evidence
- `npm run typecheck`: 0 errores.
- `npm test`: 11 archivos, 183/183 pruebas correctas.
- `npm run build`: 22/22 páginas generadas sin errores.
- Migración `hardening_round2`: aplicada con éxito (RLS + índices + `no_aplica`).
- Advisors security: RLS-disabled ERROR en 0. Quedan WARN conocidos no bloqueantes para pruebas: 5 funciones con search_path mutable y 2 DEFINER ejecutables por anon/autenticado + leaked-password deshabilitado. Decisión: van a `018_hardening_followup` fuera de este lote.

## Next step
- Ejecutar DB1 primero (define DDL 017), luego COM1+USR1 en paralelo si son ramas aisladas, cerrar con COM2/COM3/USR2 y VER.

## Route declaration
- General: delegated-direct por mapping trigger (4+ archivos) y writer trigger (2+ archivos no triviales). Sin SDD: no hay ambigüedad durable que exija proposal/spec/design.
