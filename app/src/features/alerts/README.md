# Módulo `alerts` — bandeja del admin

Las alertas son filas de `audit_logs` con acciones del conjunto de alerta
(`ALERT_ACTIONS` en `schemas.ts`: desajustes de caja, cuenta bloqueada,
comisión pagada y vale solicitado). El resto de la auditoría no avisa.

- Migración `011_alert_inbox.sql`: `is_read`/`read_at` en `audit_logs` +
  índice de sin leer por sede. Sin cambios a RLS (la app opera con
  service_role).
- Servicio (`service.ts`): `listAlerts` (sede + conjunto + filtro sin
  leer, más recientes primero, conteo + páginas de `ALERTS_PAGE_SIZE`),
  `countUnreadAlerts` (insignia del menú), `markAlertRead`
  (acotado a la sede). Escritura: solo admin (el gate vive en actions).
- Alerta de vale: la solicitud fuera de rango abre `voucher.requested`;
  aprobar o rechazar el vale la resuelve sola (`resolveVoucherAlert`), con
  el mismo mecanismo de la bandeja (`is_read`/`read_at`/`review_note`/
  `reviewed_by`). El cierre filtra por `entity_id` + `is_read:false`, por lo
  que es idempotente y no toca otras alertas.
- UI (`/alerts`, solo admin): filtro Todas/Sin leer, paginador,
  revisión con justificación obligatoria (una o todas con nota
  compartida), detalle por acción con valores (superficie
  solo-admin). Entrada en el menú (grupo Control) con insignia de sin leer.
- Tests (`tests/alerts.test.ts`): conjunto, tamaño de página y esquema.
