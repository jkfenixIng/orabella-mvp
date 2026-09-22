# Módulo `alerts` — bandeja del admin

Las alertas son filas de `audit_logs` con acciones del conjunto de alerta
(`cash.shift_open_mismatch`, `cash.shift_close_mismatch`,
`auth.login_locked`). El resto de la auditoría no avisa.

- Migración `011_alert_inbox.sql`: `is_read`/`read_at` en `audit_logs` +
  índice de sin leer por sede. Sin cambios a RLS (la app opera con
  service_role).
- Servicio (`service.ts`): `listAlerts` (sede + conjunto + filtro sin
  leer, más recientes primero, conteo + páginas de `ALERTS_PAGE_SIZE`),
  `countUnreadAlerts` (insignia del menú), `markAlertRead`/`markAllAlertsRead`
  (acotados a la sede). Escritura: solo admin (el gate vive en actions).
- UI (`/alerts`, solo admin): filtro Todas/Sin leer, paginador,
  revisión con justificación obligatoria (una o todas con nota
  compartida), detalle por acción con valores (superficie
  solo-admin). Entrada en el menú (grupo Control) con insignia de sin leer.
- Tests (`tests/alerts.test.ts`): conjunto, tamaño de página y esquema.
