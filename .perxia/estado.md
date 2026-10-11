# Estado

- **Etapa completada:** documentación de despliegue.
- **Decisión reciente:** el runner Node 20 verifica identidad y ledger en vivo antes de aplicar; acepta el DB owner/superuser auditado o `<MIGRATION_LOGIN>` con `migration_operator`, exige contrato de marcador por migración y reconcilia únicamente el primer pendiente comprobado. `006` owner / posible `007` caps siguen sin detalles inventados.
- **Siguiente:** en una ventana autorizada, crear el ledger, otorgar `migration_operator` explícitamente a `<MIGRATION_LOGIN>`, generar/aplicar/verificar el plan en vivo; para `006` owner y posible `007` caps, integrar el contrato y marcador aprobados o registrar un aplazamiento como sufijo gobernado.
