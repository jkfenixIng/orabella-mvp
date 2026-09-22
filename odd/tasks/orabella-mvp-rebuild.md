# Orabella MVP Rebuild — Seguimiento (paso 1 de 3)

## Objetivo

Generar el documento Word del MVP para el rebuild de Orabella (paso 1 de 3: Word → PRD .md → MVP).
En este paso NO se implementa código del MVP. Solo el Word + este archivo de seguimiento.

## Decisiones aprobadas (inamovibles)

- D1 — Factura: solo interna en MVP (sin DIAN). Modelo listo para DIAN fase 2 sin reestructurar.
- D2 — Caja: una caja única con apertura/cierre diario.
- D3 — Inventario: productos con stock + catálogo de servicios con precios.
- D4 — Sede: una sede hoy, modelo preparado para multi-sede futura (sede_id / tenant listo, sin multi-sede activa).
- D5 — Formato y despliegue: Word estándar estilo JMS. Vercel (front+back Next.js) + Supabase (Postgres restructurada, NO reutilizar entidades actuales).

Stack fijado: Next.js 15 App Router + React 19 + TypeScript 5.9 + Tailwind CSS 4 + shadcn/ui + next-themes + Zod 4 + Supabase JS v2 (Auth + Postgres RLS + Storage) + Vercel. Un solo repo/deploy. Monolito modular por features.

## Checklist

- [x] Word v1.0 en progreso/entregado: `D:\u\orabella\MVP_Orabella_Rebuild_v1.0.docx` (v1.0, 2026-09-17, Draft)
- [x] Word v1.1 client-facing: `D:\u\orabella\MVP_Orabella_Rebuild_v1.1.docx` (v1.1, 2026-09-17, En revisión)
- [x] Word v1.2 client-facing: `D:\u\orabella\MVP_Orabella_Rebuild_v1.2.docx` (v1.2, 2026-09-17, En revisión)
- [ ] Cliente revisa el Word v1.2 y firma aprobación (§8)
- [ ] PRD .md pendiente (paso 2, tras revisión del Word por el usuario)
- [ ] MVP pendiente (paso 3, implementación por módulos contra criterios de aceptación)

## Alcance autorizado

- Login (AUTH-01…05), panel admin sin 35 permisos granulares (ADM-01…04), inventario (INV-01…05), factura interna (FAC-01…06, sin DIAN), caja única diaria (CAJ-01…04).
- Fuera de alcance: DIAN electrónica, multi-sede activa, agenda/turnos/cola/citas, reportes Excel avanzados, PWA/offline, SSR complejo.
- Seguridad: Supabase Auth + RLS deny-by-default, service_role solo en server, Zod server-side, headers, rate-limit + WAF Vercel, secretos en env, auditoría y backups.
- Modo oscuro sin flash: next-themes + cookie SSR + script inline en `<head>`, suppressHydrationWarning.
- Costos 2026: dev Hobby + Free ($0); prod ~$25–45/mes (Supabase Pro + Vercel Hobby/Pro 1 seat). Detalle y comparativa vs. .NET en el Word (§7–§10).

## v1.1 client-facing (2026-09-17, En revisión)

### Lo quitado (contenido interno de trabajo, no va al cliente)
- Etiquetas D1-D5, frases de proceso (paso 1 de 3, decisiones aprobadas/inamovibles), menciones a ODD y al PRD .md como paso interno.
- Notas de secretos en appsettings y decisiones de chat.
- Auditoría del stack anterior (Angular, .NET, FullCalendar, SSR, Clean 4 proyectos, doble Excel/OpenAPI): reducida a 2-3 líneas (costos operativos y rigidez → rebuild total).

### Lo ampliado
- §2 por módulo con requisitos numerados + criterio de aceptación + tabla ENTIDADES (Entidad | Campos clave (tipo) | Relaciones | Notas) + línea de cobertura.
- Login/Auth completo: users, roles (admin/empleado/caja), user_roles, sessions/refresh_tokens, password_resets; flujos (solo admin registra, bloqueo por intentos, recuperación, revocación) y RLS por sede.
- Transversal: audit_logs solo acciones críticas; soft-delete + created_at/updated_at + UUID + sede_id en todas.
- Costos con qué obtiene el cliente al pagar (Free vs Pro, total prod ~$25-45/mes); cronograma 6 semanas + aprobación en §8.

### Checklist actualizado
- [x] v1.0 preservada sin sobrescribir.
- [x] v1.1 generada y verificada: 0 menciones meta-conversacionales (D1-D5, ODD, appsettings, Angular/.NET).
- [ ] Firma del cliente en §8 de v1.1.

## v1.2 client-facing (2026-09-17, En revisión)

### Qué cambió (requerimientos del dueño, todo en entidades + requisitos + criterios)
1. Usuarios: users con email unique, phone, tipo_identificacion (CC/CE/PPT/PEP/otro), numero_identificacion unique = username; clave inicial = número de documento, cada persona cambia la suya, demás datos los gestiona admin; bloqueo por intentos + recuperación (AUTH-01…07, §2.1).
2. Empleado: employees.employee_code texto nullable/vacío permitido, cambiable, único por sede solo con valor (sede_id + employee_code donde no nulo); solo empleados; UUID id sigue PK técnica (§2.2, ADM-02/ADM-03).
3. Sueldos: pay_type fijo/porcentaje/mixto + salary_fixed + commission_percent; fijo se paga fijo, porcentual/mixto se liquida desde invoice_items del periodo con reporte por factura/ítem (§2.2 + §2.6 NOM-02/NOM-03).
4. Servicios: duracion_min + duracion_max en minutos, sin duración única (ADM-05, §2.2).
5. Impuestos: tax_configs (id, code IVA/ICA/Rete/otro, name, percent, is_active, sede_id); inician todos inactivos/0; invoice_taxes guarda snapshot (ADM-06, FAC-03, §2.4).
6. Caja multi-turno: varios cash_shifts por día en la misma caja (opened_by/closed_by, opened_at/closed_at, opening/closing_amount, status); vista de cierres del día + acumulado esperado vs. contado (CAJ-01…05, §2.5).
7. Pagos Colombia: payment_methods por sede (efectivo, transferencia_normal/PSE, Nequi, Daviplata, Bre-B, tarjeta) con is_active; payments divide un cobro por método (FAC-07, CAJ-02).
8. NUEVO módulo contable/nómina (§2.6, NOM-01…04): payroll_periods (borrador/cerrado), payroll_items (base_fixed, commissions, bonuses, deductions_vales, other_discounts, net_pay, detail_json), payroll_payments (porciones por método con paid_at/paid_by/reference); cálculo automático fijo + comisiones − descuentos.
9. Vales (VAL-01…03): voucher_settings (max_per_day/max_per_week por sede), voucher_requests (pendiente/aprobada/rechazada/descontada, approved_by, approval_code dinámico básico + observation opcional); sobre topes exige aprobación admin; al liquidar se descuentan y marcan.

### Secciones tocadas en el Word
- §2: tablas ENTIDADES actualizadas (login, admin, factura, caja) + nueva §2.6 nómina/vales; cada módulo con requisitos numerados + criterio + cobertura.
- §3: relaciones payroll/vouchers/payment_methods/invoice_taxes; futuro (agenda, electrónica) sin reestructurar.
- §7: sin cambios de precios (nota v1.2: nómina/vales usan misma base y despliegue).
- §8: cronograma 6 → 8 semanas (fase 4 nómina/vales sem 6-7, producción sem 8) + aprobación.
- Portada, control de cambios (fila v1.2), índice y §1 actualizados; v1.0 y v1.1 intactas.

### Checklist actualizado
- [x] v1.0 y v1.1 preservadas sin sobrescribir.
- [x] v1.2 generada y verificada: 0 rastros meta-conversacionales (D1-D5, ODD, appsettings, Angular/.NET, pasos internos); las 9 entidades/campos nuevos presentes en texto y tablas.
- [ ] Firma del cliente en §8 de v1.2.

## Documento único canónico (2026-09-17)

Un solo Word client-facing: `D:\u\orabella\MVP_Orabella_Rebuild.docx` (sin versión en el nombre,
portada simple con título + fecha 2026-09-17, sin tabla de versiones).
Borrados `MVP_Orabella_Rebuild_v1.0.docx`, `v1.1.docx` y `v1.2.docx`; solo queda el canónico.
Secciones eliminadas: control de versiones/cambios, cronograma y aprobación/firmas.
El doc queda solo con: portada simple, índice textual, resumen+objetivos, alcance por módulo
con entidades, modelo relacional y crecimiento, plataforma, seguridad, modo oscuro y costos.
Verificado 0 rastros: D1-D5, ODD, appsettings, Angular/.NET, pasos internos, versiones, firmas.

### Lógica de base de caja (§2.5 CAJ-01…CAJ-06)

- `cash_registers` agrega `base_configurada` (ej. 300 mil), configurable por sede/caja.
- `cash_shifts` agrega: `opening_base` (viene de `base_left` del cierre anterior), `expected_cash`,
  `counted_cash`, `base_left`, `cash_withdrawn` (= contado − base dejada),
  `base_difference` (`base_left` vs `base_configurada`: faltante/sobrante) y `observation`.
- Ejemplos del dueño: si al cierre hay 400 mil en caja y la base es de 200 mil en efectivo,
  quedan 200 mil de base y se recogen 200 mil; si la base configurada es de 300 mil pero en
  efectivo solo hay 150 mil, se deja constancia de que la base para la próxima apertura es de
  150 mil (faltante de 150 mil). La próxima apertura usa `opening_base` = `base_left` anterior.
- Vista del día: lista de turnos/cierres + acumulado (ventas, esperado, contado, base dejada,
  recogido, diferencias); el acumulado cuadra con la suma de turnos.
- Criterios: no se puede cerrar sin conteo de efectivo; si `base_left` < `base_configurada`
  queda marcado como base incompleta con observación obligatoria.

### Checklist actualizado

- [x] Word único listo: `D:\u\orabella\MVP_Orabella_Rebuild.docx` (canónico, 2026-09-17).
- [x] Versiones viejas borradas (v1.0, v1.1, v1.2).
- [x] PRD .md aprobado por el usuario (2026-09-17).
- [ ] MVP en implementación por módulos contra criterios de aceptación.

## Implementación MVP (aprobada 2026-09-17, paso 3 de 3)

- TDD: off. Fuente: sin runner configurado para la nueva app Next (API/front viejos tienen los suyos, no aplican al rebuild). Checks ordinarios por tarea: typecheck + lint + build; vitest se agrega desde T1 para módulos siguientes.
- Delivery: `ask-on-risk` (default). Forecast >> 400 líneas → rama feature con work-unit commits por módulo; push/PR los decide el usuario.
- Rama: `feat/orabella-mvp` (crear desde main; todo el MVP va ahí, nunca directo a main).
- App nueva en `D:\u\orabella\app` (Next.js 15 + React 19 + TS + Tailwind 4 + Supabase + Vercel). NO tocar `API/` ni `front/`. Supabase: migraciones versionadas en `app/supabase/migrations`.
- PRD verdad: `D:\u\orabella\PRD_Orabella_MVP.md` (§5-§10 + API-first `/api/v1`).

### Tareas (una por módulo, commit por tarea)

- [x] T1 scaffold + fundación: commit `cf074f2` en `feat/orabella-mvp` (typecheck/lint/build/tests passed + smoke `/api/v1/health` en vivo). Revisión nativa T1: NO disponible (slots reofrecidos pero los 4 revisores fallan en este runtime: `OpenCode's free tier can only be used from within OpenCode`); transacción `review-6320cdb22a186f7d` queda en `reviewing` sin veredicto, sin corrección aplicada. Segundo intento tras renovación del tier: mismo fallo del runtime en los 4 slots (reofrecidos idénticos); no se reintenta más (sin loops ciegos).
- [x] T2 auth: commit `ed69730` (5 tablas + seed roles + RLS deny, login por documento con bloqueo tras 5, sesiones 12h, reset un solo uso 30min, /login + middleware, 23 tests passed). Riesgos: rate-limit en memoria (endurecer en T7), sin mailer (dev_token no-prod), email nullable, migración sin aplicar a remoto.
- [x] T3 admin: commit `4f27377` (5 tablas + índice parcial employee_code, users.sede_id NOT NULL+FK, seeds sede+6 métodos+IVA/ICA inactivos, servicio API-first + requireSedeRole, 5 rutas REST, UI /admin 4 tabs, 45/45 tests). Riesgos: RLS permisiva temporal (endurecer en T7), employees.user_id nullable difiere PRD, migraciones sin aplicar a remoto.
- [x] T4 inventario: commit `185fac5` (products + movements, triggers no-negativo/apply, SKU único por sede, kardex, alertas, UI /inventory, 64/64 tests). Riesgos: migraciones sin aplicar a remoto, RLS temporal, ADJUST no lleva a cero.
- [x] T5 factura interna: commit `59ceeaa` (sequences + invoices/items/taxes/payments, consecutivo anti-huecos, snapshot impuestos, OUT+reversión stock, cobro dividido, UI /invoices, 96/96 tests). Riesgos: atomicidad best-effort, invoice_payments interno por consolidar en T6, migraciones sin aplicar.
- [x] T6 caja multi-turno: commit `93d2138` (registers/shifts/payments, base encadenada, dual-write invoice_payments, arqueo + día/acumulado, UI /cash, 122/122 tests). Riesgos: migraciones sin aplicar, RLS temporal.
- [x] T7 nómina/vales: commit `f414267` (periods/items/payments + voucher_settings/requests, cálculo mixto con detail_json, pago por porciones, topes + código 6 dígitos, periodo inmutable, UI /payroll, 150/150 tests). MVP funcional completo T1→T7 en `feat/orabella-mvp` (7 commits, sin push). Endurecimiento hecho en T8 abajo.
- [x] T8 endurecimiento: commit `b93af88` (RLS por claim JWT sede + audit_logs en 6 acciones críticas + rate-limit Upstash-con-fallback + seeds §11 con Sonia 13, 166/166 tests). Riesgos: migraciones 001→008 sin aplicar a remoto, rate-limit por instancia sin Upstash.

## PRD técnico (2026-09-17, paso 2 de 3)

- Ruta: `D:\u\orabella\PRD_Orabella_MVP.md` (único, v1.0, En revisión, en español neutro).
- Origen: `D:\u\orabella\MVP_Orabella_Rebuild.docx` (verdad aprobada; el PRD no agrega ni quita alcance).
- Cobertura: AUTH-01…07, ADM-01…08, INV-01…05, FAC-01…07, CAJ-01…06 (base encadenada 400/200 y 300/150, base incompleta con observación obligatoria), PAY-01…07 (nómina mixta + vales con topes y aprobación), TRA-01…03; RNF de rendimiento/seguridad/modo oscuro; 15 user stories Must/Should; 4 flujos (login con cambio forzado, cierre con base incompleta, nómina mixta con pago dividido, vale sobre tope); modelo de 24 tablas con tipos/constraints/índices (incl. unique parcial sede+employee_code, un turno abierto por caja, un borrador por rango)/RLS por sede-rol + DDL crítico; Server Actions con Zod + API-first REST `/api/v1` por módulo para futura app (mismo servicio/validación, JWT Supabase, OpenAPI); costos dev $0 / prod ~$25-45; plan auth→admin→inventory→billing→cash→payroll/vouchers sin fechas.
- [x] Aprobación del PRD por el usuario para implementar (2026-09-17).

## Próximos pasos

1. Implementar T1→T7 en `feat/orabella-mvp` con work-unit commits (en curso: T1).
2. Push/PR solo cuando el usuario lo pida.

## Restricciones respetadas

- No se tocó `API/` ni `front/`.
- Documento en español neutro profesional, sin slang.
