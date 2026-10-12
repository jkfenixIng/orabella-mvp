# Estado

- **Etapa completada:** correcciones urgentes de UI, métodos de pago y caja, más la migración `008`, integradas en `chore/extraccion-supabase-fase1`.
- **Decisión reciente:** `008` fija que un método inactivo nunca es arqueable; los códigos de métodos se generan en servidor y no se aceptan del cliente.
- **Aplicado:** `008` corre en PRODUCCIÓN y en la base del CLIENTE (marcadores `002`–`008` en 7/7, inventario de objetos idéntico). PRUEBAS sigue sin `002`–`008`.
- **Corrección reciente:** `009` agrega límites del efectivo físico de apertura y observabilidad de errores de apertura; PRUEBAS sin `003` falla la lectura del catálogo por la columna `arqueo_mode` ausente y la app ahora lo expone como error accionable.
- **`009` aplicada (2026-10-12) en PRODUCCIÓN y CLIENTE:** `cash_open_shift_atomic` y `_legacy` ejecutables solo por `service_role`; marcadores `002`–`009` en 8/8, inventario idéntico. Evidencia en `~/orabella-db/evidencia-migraciones.txt`.
- **UX (feat/ux-feedback):** diálogos mantienen errores inline; toasts son interactivos sin cerrar el modal; alertas usan selector claro; inicio saluda según sesión y módulos visibles; loading states cubren inicio, caja, admin, alertas y vales.
- **Inventario (fix/r4-inventory):** el catálogo ahora consulta nombre/SKU, estado de stock, página y total en el RPC `inventory_catalog_page` de la migración `010`; no carga ni pagina el catálogo completo en cliente. El movimiento conserva su búsqueda acotada en servidor.
- **Siguiente:** aplicar `010_inventory_catalog_page.sql` por el flujo de migraciones portátil antes de desplegar esta rama; verificar el deploy de Vercel con la apertura de caja real. PRUEBAS ya no existe.
