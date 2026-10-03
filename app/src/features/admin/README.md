# Módulo `admin` (T3 — implementado)

CRUD sedes, empleados (`employee_code` único por sede solo con valor,
`pay_type` fijo/porcentaje/mixto), roles, servicios (`duracion_min/max`),
impuestos por sede (inician inactivos en 0), métodos de pago Colombia por sede.

- Tablas (migración `003_admin.sql`): `sedes`, `employees`, `services`,
  `tax_configs`, `payment_methods`. Además `users.sede_id` pasa a NOT NULL
  con FK a `sedes` (nota T2): se crea la sede inicial `Sede principal` y se
  asigna a los usuarios existentes antes de imponer el NOT NULL.
- PRD: §5.2 ADM-01…08, §9.1, §10 Admin, plan paso 2 (§12).

## Reglas implementadas

- ADM-01: `upsertSede` (nombre, dirección, teléfono, activa/inactiva).
- ADM-02/ADM-03/ADM-08: `upsertEmployee` con `employee_code` opcional y
  cambiable; unicidad parcial a nivel app (`areEmployeeCodesConflicting`:
  vacíos/nulos nunca colisionan, con valor colisionan solo en la misma sede)
  además del índice `uq_employees_sede_code`; `user_id` nullable (personal
  sin login) pero UNIQUE; coherencia `pay_type` (fijo exige `salary_fixed`
  sin comisión, porcentaje exige `commission_percent` sin fijo, mixto exige
  ambos) vía `checkPayCoherence` + `superRefine` en Zod.
- F2: `pay_frequency` (semanal/quincenal/mensual, catálogo cerrado vía
  `payFrequencySchema`) opcional en alta y edición; `null` es «sin cadencia
  definida» y conserva el cálculo de hoy (el fijo se prorratea por los días del
  período). El alta viaja por `upsert_employee_atomic`, y la migración
  `065_employee_pay_frequency.sql` reemplaza esa función con la MISMA firma para
  que escriba la columna (la 054 la ignoraba en silencio).
- ADM-04: `setUserRoles` reemplaza roles (doble rol permitido); surte efecto
  en el siguiente request porque `getSessionUser` lee `user_roles` siempre.
- ADM-05: `upsertService` con `duracion_min <= duracion_max` (Zod + CHECK).
- ADM-06: `upsertTaxConfig` con `percent` 0–100; seed IVA 19% e ICA inactivos.
- ADM-07: `upsertPaymentMethod` con códigos del catálogo Colombia
  (efectivo/transferencia_normal/nequi/daviplata/bre-b/tarjeta); seed con los
  6 activos en la sede inicial.
- Sin borrado físico: todo se desactiva con `is_active` (TRA-02).
- RLS deny-by-default en las 5 tablas; políticas T3 permisivas (`USING true`)
  con TODO documentado porque las sesiones del MVP son tokens opacos propios
  (sin claim de sede en `auth.jwt()`). La segregación la aplica hoy la capa
  servidor por ROL: `requireSedeRole` (una sola sede: ya no hay comparación de
  sede, la de la columna se retiró con ella). Endurecer en T7.

## Endpoints (REST API-first, validación Zod en servidor)

Base `/api/v1` (mismo servicio que las Server Actions en `actions.ts`):

| Método + path | Servicio | Auth |
|---|---|---|
| `GET/POST /api/v1/employees` | `listEmployees` / `upsertEmployee` | Sesión / admin para escribir |
| `GET/PATCH /api/v1/employees/:id` | `getEmployee` / `upsertEmployee` | Sesión / admin para escribir |
| `GET/POST /api/v1/services` | `listServices` / `upsertService` | Sesión / admin para escribir |
| `GET/POST /api/v1/taxes` | `listTaxes` / `upsertTaxConfig` | Sesión / admin para escribir |
| `GET/POST /api/v1/payment-methods` | `listPaymentMethods` / `upsertPaymentMethod` | Sesión / admin para escribir |

Respuestas con `ok()`/`fail()` (`{success, data}` / `{success:false, code,
message}`). Lecturas con `?sede_id=` (por defecto la sede de la sesión);
escrituras con rol admin verificado en servidor.

## UI mínima (`/admin`)

Solo rol admin (el resto ve 403). Tabs Empleados / Servicios / Impuestos /
Métodos de pago con listado y formularios básicos de crear/editar (español,
ThemeToggle y estilos existentes). Carga inicial en servidor; mutaciones vía
Server Actions sobre el mismo servicio que la API.

## Tests

`tests/admin.test.ts` (vitest, unit, sin red): esquemas Zod (pay_type
coherente, min<=max, percent 0–100, códigos de pago, roles), unicidad parcial
(normalización y conflictos), `requireSedeRole`, y contenido de
la migración `003_admin.sql` (5 tablas, índice parcial, NOT NULL + FK,
políticas RLS con TODO, seeds).

## Límites de lectura

- Navegación instantánea: `listSedes`/`listEmployees`/`listServices`/`listTaxes`/`listPaymentMethods` acotados a 50 filas por defecto (límite explícito 500 solo para validaciones internas de facturación/nómina).

## UI

- Sub-menú con el primitivo `Tabs`; crear y editar pasan por `FormDialog`; la
  baja de una denominación pide `ConfirmDialog`; las tablas de empleados y
  usuarios usan `DataTable`; los vacíos usan `EmptyState`; el reseteo de clave
  se confirma en la propia fila (confirmación inline, no diálogo).
- La frecuencia de pago del empleado se pregunta en el mismo `FormDialog` de
  alta/edición (select con «Sin definir» + la fracción en dinero de cada
  cadencia) y se muestra en el detalle; `Sin definir` guarda `null` y no cambia
  nada.
- El diálogo "Nuevo usuario" se eliminó: los usuarios se crean con el
  empleado, así que ese diálogo nunca podía ser el segundo camino.
- Vocabulario y superficies: `app/docs/ux-ui-standard.md`.
