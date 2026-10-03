-- 027_products_commission.sql — comisión sugerida por producto (I1).
--
-- Modelo: products.commission_value es un valor ABSOLUTO sugerido. Al elegir
-- el producto en el diálogo de factura se precarga como comisión de la línea;
-- si el cajero la edita a mano, el valor de la línea manda. NULL = sin
-- sugerencia (la línea decide, como hasta ahora).
-- No reemplaza las reglas empleado×ítem de commission_rules: son otra capa.
-- Re-ejecutable: ADD COLUMN IF NOT EXISTS + bloque DO para el CHECK.

-- ------------------------------------------------- columna ---
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS commission_value numeric(12, 2) NULL;

-- ------------------------------------------------- CHECK ---
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_commission_value'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT chk_products_commission_value
      CHECK (commission_value IS NULL OR commission_value >= 0);
  END IF;
END
$$;

COMMENT ON COLUMN public.products.commission_value IS
'I1: comisión sugerida del producto (valor absoluto). Precarga la comisión de la línea al facturar; el valor editado en la línea manda. NULL = sin sugerencia.';
