-- 011_alert_inbox.sql — estado de lectura para la bandeja de alertas (admin).
--
-- Las alertas son filas de audit_logs con acciones del conjunto de alerta
-- (desajustes de apertura/cierre de caja, cuentas bloqueadas). El contenido
-- no cambia (append-only); solo se marca lectura por sede. La app lee y
-- marca vía service_role, sin cambios a las políticas RLS.

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS is_read boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS read_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_sede_unread
  ON public.audit_logs (sede_id, created_at)
  WHERE (is_read = false);

COMMENT ON COLUMN public.audit_logs.is_read IS
  'Bandeja admin: si la alerta ya fue revisada. Solo lo marca un admin de la sede.';
COMMENT ON COLUMN public.audit_logs.read_at IS
  'Bandeja admin: cuándo se marcó como revisada. NULL mientras siga sin leer.';
