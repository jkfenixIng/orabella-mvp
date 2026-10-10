-- 004_inventory_literal_search.sql
--
-- Literal, case-insensitive product search for inventory. PostgREST's `.or()`
-- logic tree treats commas/parentheses as syntax and rewrites `*` in LIKE
-- values; this server-side function accepts the text as a typed parameter and
-- escapes the PostgreSQL LIKE metacharacters itself. No dynamic SQL.
--
-- The function returns one bounded page in the total order name ASC, id ASC.
-- It is transactional and idempotent (`CREATE OR REPLACE`).
BEGIN;

CREATE OR REPLACE FUNCTION public.search_products_literal(
  p_query text,
  p_limit integer,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  sku text,
  name text,
  description text,
  stock_qty integer,
  min_stock integer,
  cost_price numeric,
  sale_price numeric,
  commission_value numeric,
  is_active boolean
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_escape constant text := chr(92);
  v_pattern text;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  -- Escape the escape character first, then LIKE's two metacharacters. The
  -- query remains a value throughout: neither its text nor the order is SQL.
  v_pattern := '%' || replace(
    replace(
      replace(coalesce(p_query, ''), v_escape, v_escape || v_escape),
      '%', v_escape || '%'
    ),
    '_', v_escape || '_'
  ) || '%';

  RETURN QUERY
  SELECT
    p.id,
    p.sku,
    p.name,
    p.description,
    p.stock_qty,
    p.min_stock,
    p.cost_price,
    p.sale_price,
    p.commission_value,
    p.is_active
  FROM public.products AS p
  WHERE p.name ILIKE v_pattern ESCAPE v_escape
     OR p.sku ILIKE v_pattern ESCAPE v_escape
  ORDER BY p.name ASC, p.id ASC
  LIMIT v_limit
  OFFSET v_offset;
END;
$$;

-- Supabase's default privileges grant EXECUTE on new public functions to anon
-- and authenticated by name; revoking PUBLIC alone leaves those grants.
REVOKE ALL ON FUNCTION public.search_products_literal(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_products_literal(text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.search_products_literal(text, integer, integer) FROM authenticated;
GRANT ALL ON FUNCTION public.search_products_literal(text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.search_products_literal(text, integer, integer) IS
  'Fase 3b-2: búsqueda literal y case-insensitive de productos por name o sku. Escapa %, _, barra invertida y usa parámetros tipados, por lo que *, comas, paréntesis y comillas son texto, no sintaxis PostgREST/SQL. Devuelve una página acotada y estable por name, id; solo service_role puede ejecutarla.';

COMMIT;
