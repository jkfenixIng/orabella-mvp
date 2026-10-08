-- 029_voucher_created_by.sql — usuario de caja que abrió el vale.
--
-- El vale lo abre la caja (turno abierto), pero hasta ahora no se registraba
-- QUIÉN lo abrió. Se agrega created_by para poder mostrarlo en el detalle del
-- vale, junto con approved_by (quien lo aprobó), que ya existía.
--
-- Columnas:
--   - voucher_requests.created_by: usuario de caja que abrió el vale.
--     NULL = vale histórico (previo a esta migración) sin autor registrado.
--
-- approved_by y approval_code se CONSERVAN intactos: esta migración solo agrega.
--
-- Re-ejecutable: ADD COLUMN IF NOT EXISTS.

-- ------------------------------------------------- columnas ---
ALTER TABLE public.voucher_requests
  ADD COLUMN IF NOT EXISTS created_by uuid NULL REFERENCES public.users (id) ON DELETE SET NULL;

-- Sin índice por created_by: ninguna consulta filtra ni une por esta columna;
-- solo se lee para resolver un nombre contra users (por su PK). approved_by,
-- de la misma forma, tampoco lo tiene.

-- ------------------------------------------------- comentarios ---
COMMENT ON COLUMN public.voucher_requests.created_by IS
  'Usuario de caja que abrió el vale (turno abierto). NULL = vale histórico, sin autor registrado.';
