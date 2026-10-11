# Módulo `alerts` — bandeja del admin

Las alertas son filas de `audit_logs` con acciones del conjunto de alerta
(`ALERT_ACTIONS` en `schemas.ts`: desajustes de caja, cuenta bloqueada, vale
solicitado y **el residuo de un alta cuya compensación también falló**,
`auth.user_create_rollback_failed`). El resto de la auditoría no avisa: la
comisión pagada se audita (`payroll.commission_paid`) pero no es alerta, porque
es un evento rutinario que no pide ninguna acción del admin.

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
- Orden de la bandeja (cambio intencional, Fase 3b-1 de la extracción de
  Supabase): `created_at DESC, id DESC` en los dos motores (supabase-js y
  PostgreSQL directo). Antes solo era `created_at DESC`, y PostgreSQL no
  garantiza el orden entre alertas del mismo instante: al paginar, una alerta
  podía repetirse en dos páginas o no aparecer en ninguna. El `id` desempata y
  vuelve el orden total. Lo único observable es el orden RELATIVO de alertas
  con el mismo `created_at`; el conteo, los filtros y el tamaño de página no
  cambian.
- Acceso a datos: puerto `repos/alerts.ts` (supabase-js por defecto) y
  `repos/alerts.drizzle.ts` (solo con `DB_ENGINE=postgres`, cargado con
  `import()`).
- Tests (`tests/alerts.test.ts`): conjunto, tamaño de página y esquema.
  `tests/alerts-service.test.ts` fija las peticiones de supabase-js;
  `tests/db/alerts.repo.db.test.ts` prueba la equivalencia entre motores,
  incluidos empates de `created_at` repartidos entre dos páginas.
