-- 021_client_optional.sql — El nombre del cliente es opcional.
--
-- El código (schemas, servicio, UI) ya trata client_name como opcional
-- (vacío = NULL), pero el DDL de 005 lo dejó NOT NULL: cualquier emisión
-- sin nombre fallaba con 23502. Esta migración alinea la BD con el código.

ALTER TABLE public.invoices
  ALTER COLUMN client_name DROP NOT NULL;

COMMENT ON COLUMN public.invoices.client_name IS
'Opcional: muchos clientes no dan su nombre. NULL = mostrador / sin nombre.';
