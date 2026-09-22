-- 014_detach_orphan_open_mismatches.sql — corrección del backfill 013.
--
-- 013 ataba cada alerta vieja al turno abierto dentro de 15 minutos, y en
-- pruebas rápidas (abre/cierra en minutos) dos alertas podían caer sobre
-- el mismo turno, o una alerta huérfana (su turno nunca se creó porque el
-- insert falló después de auditar) quedaba pegada a otro turno.
-- Este UPDATE desata las que no corresponden a su turno: conserva solo el
-- match exacto (turno abierto entre 1 minuto antes y 2 después de la
-- alerta) y devuelve el resto a nivel caja. Idempotente.
-- Hacia adelante no puede repetirse: la app archiva cada desajuste de
-- apertura contra el turno recién creado, por id exacto.
UPDATE public.audit_logs AS a
SET entity = 'cash_registers',
    entity_id = s.cash_register_id::text
FROM public.cash_shifts AS s
WHERE a.action = 'cash.shift_open_mismatch'
  AND a.entity = 'cash_shifts'
  AND s.id::text = a.entity_id
  AND NOT EXISTS (
    SELECT 1
    FROM public.cash_shifts AS s2
    WHERE s2.id::text = a.entity_id
      AND s2.opened_at >= a.created_at - interval '1 minute'
      AND s2.opened_at <= a.created_at + interval '2 minutes'
  );
