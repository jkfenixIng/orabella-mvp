# Estado

- **Etapa completada:** documentación de despliegue.
- **Decisión reciente:** el runbook `docs/supabase-to-postgres-deployment-runbook.md` separa preparación de escrituras irreversibles, exige backup verificado y aprobación humana antes de producción, mantiene el traspaso de datos como procedimiento de integración separado, y conserva `006` owner / posible `007` caps como dependencias pendientes sin detalles inventados.
- **Siguiente:** ejecutar el runbook únicamente cuando existan las integraciones pendientes aprobadas y una ventana de despliegue autorizada.
