# Módulo `inventory` (T4 — implementado)

CRUD de productos con SKU único por sede, movimientos IN/OUT/ADJUST con
motivo y responsable (kardex), stock derivado exclusivamente de
movimientos, bloqueo de venta sin stock, alerta de mínimo y búsqueda por
nombre o SKU (INV-01…05).

## Tablas (migración `supabase/migrations/004_inventory.sql`)

- `products`: `sede_id` FK NOT NULL, `sku` NOT NULL (UNIQUE por sede),
  `name`, `description`, `stock_qty` (default 0, CHECK >= 0),
  `min_stock` (default 0), `cost_price`/`sale_price` (nullable, >= 0),
  `is_active`, `created_at`/`updated_at` + trigger `set_updated_at`.
  El SKU se guarda normalizado (trim + mayúsculas) desde el servicio.
- `inventory_movements`: `sede_id` FK, `product_id` FK, `type`
  (IN/OUT/ADJUST), `qty` > 0, `reason` NOT NULL, `user_id` FK nullable
  (movimientos del sistema, p. ej. reversión de T5), `created_at`.

## Stock solo vía movimientos (INV-03/INV-04)

1. La app nunca escribe `stock_qty` directo (`upsertProduct` no lo
   incluye en ningún payload).
2. `trg_inventory_apply_stock` (AFTER INSERT) recalcula: IN suma, OUT
   resta, ADJUST fija el nivel absoluto (= qty del movimiento).
3. `trg_inventory_no_negative` (BEFORE INSERT) toma lock de fila
   (`SELECT … FOR UPDATE`) y rechaza el OUT que dejaría negativo
   (excepción `INSUFFICIENT_STOCK`). El servicio pre-verifica para un
   error claro y traduce la excepción (carreras) al mismo 409.
4. Apoyo: `CHECK (stock_qty >= 0)` en `products`.
5. ADJUST fija niveles > 0; para llevar a cero se usa OUT del remanente
   (queda auditado en el kardex).

## Servicio compartido (API-first)

- `src/features/inventory/schemas.ts`: `productSchema`,
  `movementSchema` (qty > 0, motivo obligatorio) + puros
  (`normalizeSku`, `areSkusConflicting`, `applyMovementStock`,
  `matchesProductQuery`, `isLowStock`/`filterLowStock`,
  `sortKardexAscending`).
- `src/features/inventory/service.ts`: `upsertProduct`
  (SKU_TAKEN 409, nunca toca stock), `registerMovement`
  (INSUFFICIENT_STOCK 409), `getKardex` (ascendente), `searchProducts`
  (nombre o SKU, solo sede), `lowStockAlerts` (stock <= mínimo),
  `listProducts`/`getProduct`. Reutiliza `requireSedeRole`/`resolveSede`
  de `admin/service.ts`; escritura solo admin/caja
  (`requireInventoryWriter`), lectura cualquier rol de su sede.
- `src/features/inventory/actions.ts`: Server Actions espejo.
- REST `/api/v1`: `GET/POST /products` (`?q=` cubre `products:search`
  del PRD), `GET/PATCH /products/:id`, `POST /inventory/movements`,
  `GET /inventory/kardex?product_id=`, `GET /inventory/alerts`.
  Errores `{success:false, code, message}` vía `ok()`/`fail()`.
- UI `/inventory`: tabla (SKU, nombre, stock, mínimo, precios, alerta),
  búsqueda, crear/editar producto, registrar movimiento
  (tipo + cantidad + motivo) y vista de kardex. Español, estilos de T3.

## RLS

Deny-by-default con políticas por sede permisivas temporales
(`USING true`) + `TODO(seguridad-T7)`: las sesiones del MVP son tokens
opacos propios, sin claim de sede en `auth.jwt()`; la segregación la
aplica la capa servidor. Endurecer al migrar a JWT de Supabase.
