-- 012_alert_review_note.sql — justificación de revisión en la bandeja (admin).
--
-- Cuando el admin revisa una alerta (p. ej. tras hablar con la persona del
-- turno), deja traza escrita de lo sucedido. Columnas solo de revisión;
-- el contenido original de audit_logs no se toca.

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS review_note text NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid NULL REFERENCES public.users (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.audit_logs.review_note IS
  'Bandeja admin: justificación obligatoria al marcar como revisada (qué pasó, qué se habló).';
COMMENT ON COLUMN public.audit_logs.reviewed_by IS
  'Bandeja admin: quién la marcó como revisada.';
