# Env Setup - Test y Productivo + Limpieza Productiva

## Objetivo
Preparar ambientes de pruebas y productivo. Productivo debe quedar limpio en productos, usuarios e historial de caja, con únicamente el admin 1018474080 (Camilo Rodriguez). Corregir integración Vercel que fallaba por nesting depth 10.

## Contexto
- Supabase proyecto pcpzncdfyevzylyokdjg (URL https://pcpzncdfyevzylyokdjg.supabase.co) - único proyecto actual, usado para ambos ambientes vía Vercel env vars (preview vs production).
- app/.env.local tenía keys truncadas (46/41 chars) - no son JWT reales; Supabase MCP es la vía operativa verificada.
- Estado actual DB (2026-09-21): users 10, products 5, inventory_movements 5, cash_shifts 2, payments 1, voucher_requests 1, audit_logs 5, invoices 0.
- Vercel MCP deshabilitado por error `JSON schema exceeds the maximum nesting depth of 10 levels`.
- Branch feat/orabella-mvp con todo el MVP + cash-control.

## Decisiones autorizadas
- Vercel MCP REMOVIDO por completo en opencode.json (bloque mcp eliminado commit a341ac3) - se gestiona Vercel SOLO vía CLI/dashboard, evita nesting depth definitivo.
- Limpieza productiva opera sobre el proyecto principal (pcpzncdfyevzylyokdjg) y deja 1 sede, 1 cash_register, roles, payment_methods, tax_configs, services intactos.
- Test: proyecto Supabase FREE separado (gratis, mismo plan que prod Free) en lugar de branch Pro (~$25/mes). Preview Vercel apunta al proyecto test, Production al proyecto prod limpio. Seed acceptance.sql idempotente para test.
- Admin productivo: CC 1018474080, Camilo Rodriguez, email camilo.rodriguez@orabella.co, clave inicial = documento, must_change_password=true, rol admin.

## Tareas (IDs estables)
- [x] ENV-00 Remover Vercel MCP por completo (opencode.json sin mcp) - a341ac3, Vercel CLI 59.24.0 instalado global
- [x] ENV-01 Auditar estado actual de BD (counts vía Supabase MCP) - users 10, products 5, cash_shifts 2, payments 1 verificados
- [x] ENV-02 Supabase test como proyecto FREE separado creado por el usuario (vmnyxhoqnpqwumynlbun) - pendiente cargarle esquema vía SQL Editor con app/supabase/test-bootstrap.sql (001→010 + seed)
- [x] ENV-03 Limpieza productiva idempotente: productos, movimientos, usuarios no-admin, empleados no-admin, historial caja (cash_shifts/payments), voucher_requests, sessions, audit_logs - ejecutado 2026-09-21, preservando sede/cash_register/catálogos
- [x] ENV-04 Upsert admin 1018474080 Camilo Rodriguez (hash scrypt, sede 7cac5a22..., rol admin, employee ADMIN f2a1ec5a...) - creado y verificado
- [x] ENV-05 Verificar limpieza (counts finales) - users 1, products 0, inventory_movements 0, cash_shifts 0, payments 0, voucher_requests 0, audit_logs 0 - OK
- [x] ENV-06 Vercel CLI login (jkfenixing) + link orabella + env prod (URL+anon JWT prod) verificado
- [x] ENV-07 Vercel Preview apuntado al test (URL test + publishable test + secret test como Secret) - verificado con env pull preview
- [x] ENV-08 Esquema cargado en test vía pooler ca-central-1 (001→010 + acceptance.sql) - users 10, products 3, services 4, methods 6, registers 1 verificados
- [x] ENV-09 Migraciones 009+010 aplicadas a prod vía MCP (cash_shift_counts + cash_denominations con 11 COP) - prod intacto: users 1, products 0, shifts 0
- [x] ENV-10 Ramas: develop = pruebas (fast-forward a 02cc61f con todo el MVP, pusheado), main = producción (se actualiza solo con aprobación explícita antes del deploy a prod)
- [ ] ENV-11 Vercel: Root Directory `app` + Production Branch `main` (dashboard) + SUPABASE_SERVICE_ROLE_KEY de prod; Preview sale solo de develop con env test
- [x] ENV-12 Preview manual desde app/ por CLI (Root Directory aún en raíz): build Next.js OK 45s, Ready https://orabella-15cg1anub-camilo-rodriguezs-projects-030d5ccd.vercel.app - con Deployment Protection (SSO) activa, abrir logueado en Vercel o desactivarla

## Alcance autorizado
- Solo tablas de negocio indicadas. No tocar migrations. No tocar API/ ni front/ legacy.
- No crear usuarios fuera del admin indicado en productivo. Test puede tener seed completo.

## Criterios de aceptación
- Productivo: SELECT count(*) FROM products =0, FROM users =1 (id_number=1018474080), FROM cash_shifts =0, FROM payments=0, FROM inventory_movements=0, admin con rol admin y must_change_password=true.
- Test/preview: acceptance.sql re-ejecutable sin duplicar, con 10 empleados ficticios, 4 servicios, 3 productos + movimientos, etc. (o branch separado si se crea).
- Vercel MCP no causa error de nesting; opencode.json con enabled:false.
- Documentación de env vars por ambiente entregada.

## Checks aplicables
- supabase_list_tables / supabase_execute_sql para verificar counts
- npm run typecheck / build desde app/ (si se toca código)
- Login con 1018474080 / 1018474080 exige cambio de clave (AUTH-01)

## Progreso
- 2026-09-21: detectado error Vercel nesting, deshabilitado MCP. Auditado DB actual. Generado hash scrypt para 1018474080.
- 2026-09-21: limpieza productiva ejecutada vía Supabase MCP: payments/cash_shifts/inventory/products/vouchers/payroll/invoices/audit vaciados; users/employees no-admin eliminados; admin 1018474080 verificado con must_change_password=true y rol admin. Counts finales validados. Branch test no creado por costo; se usa acceptance.sql idempotente para pruebas.
- Commit work-unit pendiente. Vercel se gestiona vía dashboard/CLI (sin MCP) para evitar nesting depth 10.
