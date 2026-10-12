# Estado

- **Etapa completada:** correcciones urgentes de UI, métodos de pago y caja, más la migración `008`, integradas en `chore/extraccion-supabase-fase1`.
- **Decisión reciente:** `008` fija que un método inactivo nunca es arqueable; los códigos de métodos se generan en servidor y no se aceptan del cliente.
- **Aplicado:** `008` corre en PRODUCCIÓN y en la base del CLIENTE (marcadores `002`–`008` en 7/7, inventario de objetos idéntico). PRUEBAS sigue sin `002`–`008`.
- **Siguiente:** verificar el deploy de Vercel en `main` y, si se quiere PRUEBAS al día, aplicar allí la serie `002`–`008` (hoy no entra: la `008` depende de la `003`).
