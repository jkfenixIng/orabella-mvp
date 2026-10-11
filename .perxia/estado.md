# Estado

- **Etapa completada:** integración local de 006/007, cierre PostgreSQL y runbook de despliegue en `chore/extraccion-supabase-fase1`.
- **Decisión reciente:** el plan portátil descubre `002`–`007` con marcadores SQL revisados; 006 solo se provisiona/recupera por DB owner y 007 conserva céntimos históricos al comparar topes con `round()`.
- **Siguiente:** ventana autorizada de staging/producción: bootstrap de ledger, plan/aplicación/verificación y, si 006 entra en alcance, provisión manual del owner por DB owner. Sin push ni despliegue en esta integración.
