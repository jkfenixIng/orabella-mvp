-- 018_hardening_followup.sql — Cierra WARNs pendientes de advisors (no bloqueantes).
--
-- 1. search_path mutable en 5 funciones + 2 DEFINER ya fijadas en 008
--    (se reafirman por idempotencia con firmas exactas verificadas).
-- 2. DEFINER ejecutables por anon: se revoca PUBLIC/anon; current_sede_id
--    queda para authenticated (la usan las políticas RLS); write_audit_log
--    queda solo service_role (solo servidor, nunca RPC cliente).
-- Nota: leaked-password protection es ajuste de Auth en Dashboard
-- (Authentication > Password protection), no SQL; queda como acción manual.

-- ------------------------------------------------- search_path ---
ALTER FUNCTION public.check_payroll_payments_cap() SET search_path = public;
ALTER FUNCTION public.inventory_apply_stock() SET search_path = public;
ALTER FUNCTION public.inventory_no_negative_stock() SET search_path = public;
ALTER FUNCTION public.next_invoice_number(uuid) SET search_path = public;
ALTER FUNCTION public.set_updated_at() SET search_path = public;
ALTER FUNCTION public.current_sede_id() SET search_path = public;
ALTER FUNCTION public.write_audit_log(uuid, uuid, text, text, text, jsonb) SET search_path = public;

-- ------------------------------------------------- DEFINER lockdown ---
-- current_sede_id: la usan las políticas RLS de clientes JWT.
REVOKE ALL ON FUNCTION public.current_sede_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_sede_id() FROM anon;
GRANT EXECUTE ON FUNCTION public.current_sede_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_sede_id() TO service_role;

-- write_audit_log: helper solo servidor (triggers futuros + service_role).
REVOKE ALL ON FUNCTION public.write_audit_log(uuid, uuid, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.write_audit_log(uuid, uuid, text, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.write_audit_log(uuid, uuid, text, text, text, jsonb) FROM authenticated;
GRANT ALL ON FUNCTION public.write_audit_log(uuid, uuid, text, text, text, jsonb) TO service_role;
