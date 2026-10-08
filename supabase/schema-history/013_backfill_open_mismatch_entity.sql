-- 013_backfill_open_mismatch_entity.sql — reparación única, idempotente.
--
-- Las auditorías de desajuste de apertura anteriores al cambio de formato
-- quedaron archivadas contra la caja (entity cash_registers); las vistas
-- las buscan por turno. Este UPDATE las ata al turno abierto justo después
-- en la misma sede y caja (ventana de 15 minutos, el más cercano). En
-- bases nuevas no encuentra nada y no hace nada.
WITH candidatos AS (
  SELECT a.id AS audit_id, s.id AS shift_id, s.opened_at AS opened_at
  FROM public.audit_logs AS a
  JOIN public.cash_shifts AS s
    ON s.sede_id = a.sede_id
   AND s.cash_register_id::text = a.entity_id
   AND s.opened_at >= a.created_at
   AND s.opened_at < a.created_at + interval '15 minutes'
  WHERE a.action = 'cash.shift_open_mismatch'
    AND a.entity = 'cash_registers'
),
elegido AS (
  SELECT DISTINCT ON (audit_id) audit_id, shift_id
  FROM candidatos
  ORDER BY audit_id, opened_at
)
UPDATE public.audit_logs AS a
SET entity = 'cash_shifts',
    entity_id = elegido.shift_id
FROM elegido
WHERE a.id = elegido.audit_id;
