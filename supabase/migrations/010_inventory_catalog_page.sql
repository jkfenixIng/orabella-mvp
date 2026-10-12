-- 010_inventory_catalog_page.sql
--
-- Server-side catalog query for inventory. The page and total are derived from
-- the same filtered relation, so the client never filters or paginates a loaded
-- product catalog.
BEGIN;

CREATE OR REPLACE FUNCTION public.inventory_catalog_page(
  p_query text DEFAULT '',
  p_stock_filter text DEFAULT 'all',
  p_limit integer DEFAULT 15,
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
  is_active boolean,
  total_count bigint
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_escape constant text := chr(92);
  v_pattern text;
  v_filter text := coalesce(p_stock_filter, 'all');
  v_limit integer := least(greatest(coalesce(p_limit, 15), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF v_filter NOT IN ('all', 'low', 'out') THEN
    RAISE EXCEPTION 'INVALID_STOCK_FILTER';
  END IF;

  v_pattern := '%' || replace(
    replace(
      replace(btrim(coalesce(p_query, '')), v_escape, v_escape || v_escape),
      '%', v_escape || '%'
    ),
    '_', v_escape || '_'
  ) || '%';

  RETURN QUERY
  WITH filtered AS (
    SELECT p.*
    FROM public.products AS p
    WHERE (btrim(coalesce(p_query, '')) = ''
      OR p.name ILIKE v_pattern ESCAPE v_escape
      OR p.sku ILIKE v_pattern ESCAPE v_escape)
      AND (v_filter = 'all'
        OR (v_filter = 'out' AND p.stock_qty = 0)
        OR (v_filter = 'low' AND p.stock_qty > 0 AND p.stock_qty <= p.min_stock))
  )
  SELECT
    p.id, p.sku, p.name, p.description, p.stock_qty, p.min_stock,
    p.cost_price, p.sale_price, p.commission_value, p.is_active,
    count(*) OVER () AS total_count
  FROM filtered AS p
  ORDER BY p.name ASC, p.id ASC
  LIMIT v_limit
  OFFSET v_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.inventory_catalog_page(text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inventory_catalog_page(text, text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.inventory_catalog_page(text, text, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.inventory_catalog_page(text, text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.inventory_catalog_page(text, text, integer, integer) IS
  '010: paginated inventory catalog with literal name/SKU query, all/low/out stock filters and total_count from the same server-side relation. service_role only.';

COMMIT;
