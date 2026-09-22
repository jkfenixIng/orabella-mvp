# PRD Técnico — MVP Orabella (Rebuild total)

## 1. Metadata

| Campo | Valor |
|---|---|
| Título | PRD Técnico — MVP Orabella (rebuild total) |
| Versión | 1.0 |
| Fecha | 2026-09-17 |
| Estado | En revisión |
| Origen | Documento Word único aprobado: `MVP_Orabella_Rebuild.docx` (2026-09-17). Es la única fuente funcional aprobada; este PRD la convierte en especificación técnica implementable sin agregar ni quitar alcance. |
| Stack fijado | Next.js 15 App Router + React 19 + TypeScript 5.9 + Tailwind CSS 4 + shadcn/ui + next-themes + Zod 4 + Supabase JS v2 (Auth + Postgres RLS + Storage) + Vercel. Un solo repo y un solo despliegue. Monolito modular por features. |
| Convención del documento | Requisitos numerados por módulo. Cada requisito funcional es medible y trae criterio de aceptación en formato Dado/Cuando/Entonces donde aplica. |

## 2. Visión general

Orabella es el sistema operativo de un negocio de belleza con una sede: gestiona acceso por roles con el número de documento como usuario, administración de empleados/servicios/impuestos/métodos de pago, inventario con kardex, factura interna con consecutivo por sede, caja multi-turno con base de caja encadenada y arqueo por turno, y el módulo contable de nómina (fijo/porcentaje/mixto) con vales sujetos a topes y aprobación.

El problema que resuelve es operar con una plataforma costosa y rígida que dificulta crecer: cada cambio (un impuesto, un método de pago como Nequi o Bre-B, un turno adicional de caja, un esquema de sueldo) exige esfuerzo desproporcionado. El MVP reconstruye lo esencial sobre una plataforma gestionada de bajo costo, con modelo de datos preparado para crecer (multi-sede futura, agenda, factura electrónica) sin reestructurar lo construido.

El beneficio es triple: costo operativo bajo desde el día uno, salida completa de los bloques críticos en un solo despliegue, y crecimiento por adición de tablas y módulos nuevos en lugar de migraciones destructivas.

## 3. Objetivos SMART

| ID | Objetivo | Meta verificable | Medición |
|---|---|---|---|
| OE-01 | Operar barato | Producción estimada en ~$25–45/mes (ver §11), sin servidores que administrar | Factura de Vercel + Supabase del primer mes productivo dentro del rango salvo uso extraordinario documentado |
| OE-02 | Salir rápido y completo | Los 6 bloques funcionales (§5: acceso, admin, inventario, factura, caja, nómina/vales) operando con sus criterios de aceptación en un solo despliegue | 100% de requisitos Must en estado aceptado según §11 (criterios globales) |
| OE-03 | Crecer sin reestructurar | Toda tabla de negocio usa UUID + `sede_id` + auditoría; un módulo futuro solo agrega tablas propias | Revisión de esquema: 0 tablas de negocio sin `sede_id`; 0 alteraciones destructivas a tablas existentes al agregar un módulo piloto |
| OE-04 | Caja cuadrada a diario | El acumulado del día cuadra con la suma de turnos y toda diferencia de base queda marcada con observación | 100% de días cerrados con acumulado consistente; 100% de bases incompletas con observación obligatoria registrada |
| OE-05 | Nómina justificable | Todo neto liquidado se explica por factura e ítem desde el reporte | Auditoría de 1 periodo de muestra: cada `payroll_items.net_pay` reproduce su `detail_json` sin diferencias |

## 4. Alcance

### 4.1 In-scope (dentro del MVP)

- Acceso y usuarios: login con número de documento, clave inicial igual al documento con cambio forzado, cambio de clave propia, sesiones con expiración/revocación/timeout, registro solo por admin, bloqueo por intentos, recuperación con token de un solo uso, 3 roles (admin/empleado/caja) sin permisos granulares.
- Administración: CRUD de sedes (una activa en operación), CRUD de empleados vinculados a usuario con `employee_code` visible opcional y cambiable, asignación de roles, catálogo de servicios con rango de duración (`duracion_min`/`duracion_max`), impuestos configurables por sede (inician todos inactivos en 0), catálogo de métodos de pago de Colombia por sede (efectivo, transferencia normal/PSE, Nequi, Daviplata, Bre-B, tarjeta).
- Inventario: CRUD de productos con SKU único, movimientos IN/OUT/ADJUST con motivo y responsable (kardex), stock derivado exclusivamente de movimientos, bloqueo de venta sin stock, alerta de mínimo, búsqueda por nombre o SKU.
- Factura interna: ítems de tipo producto/servicio/personalizado, empleado por línea (base de comisiones), descuentos por factura o ítem, impuestos con snapshot por factura, estados Emitida/Pagada/Anulada (anulación con motivo, sin borrado), consecutivo automático por sede sin huecos ni duplicados bajo concurrencia, descuento automático de stock y reversión al anular, cobro dividido en porciones por método de pago.
- Caja multi-turno: una caja física, varios turnos por día con responsables distintos, apertura con base encadenada (`opening_base` = `base_left` del cierre anterior), pagos vinculados al turno abierto, cierre con arqueo y conteo obligatorio de efectivo, base configurable (`base_configurada`), registro de base dejada / recogido / diferencia de base con ejemplos 400/200 y 300/150, vista del día con acumulado consistente, historial por fecha.
- Nómina y vales: periodos por sede (borrador/cerrado, cerrado inmutable), cálculo automático base fija + comisiones desde facturación + bonos − vales − otros = neto, detalle justificable por factura/ítem (`detail_json` + reporte), pago del ítem en porciones por método, topes de vales por sede (día/semana), solicitudes pendiente/aprobada/rechazada/descontada con aprobación admin y código dinámico básico al superar topes, descuento automático de vales al liquidar.
- Transversales: auditoría de acciones críticas, borrado lógico (nada crítico se elimina físicamente), `sede_id` + `created_at`/`updated_at` + UUID en toda tabla de negocio, RLS por sede, modo oscuro sin flash, despliegue único Vercel + Supabase.

### 4.2 Out-of-scope (fuera del MVP, modelo ya preparado)

- Facturación electrónica DIAN (el modelo guarda snapshot de impuestos y deja espacio para tablas de documentos electrónicos sin tocar la factura interna).
- Multi-sede activa (el esquema ya lleva `sede_id` en todo; opera una sola sede).
- Agenda/turnos/cola/citas (los servicios ya llevan rango de duración orientativo; el módulo agenda agregará sus tablas propias).
- Reportes Excel avanzados, PWA/offline, SSR complejo.
- Matriz de 35+ permisos granulares (solo 3 roles fijos en MVP).

## 5. Requisitos funcionales

### 5.1 Acceso y usuarios (AUTH)

- **AUTH-01** — Inicio de sesión con número de documento como usuario y contraseña. La contraseña inicial es el mismo número de documento y su cambio es obligatorio en el primer ingreso. Medible: 100% de cuentas nuevas exigen cambio en el primer login.
  - *Dado* un usuario creado por el admin con clave inicial igual a su documento, *cuando* ingresa por primera vez, *entonces* el sistema lo redirige al cambio de clave y bloquea cualquier otra acción hasta completarlo.
- **AUTH-02** — Cada persona cambia su propia contraseña desde su sesión; los demás datos los gestiona el administrador. Medible: 0 cambios de datos personales por fuera del panel admin.
  - *Dado* un usuario autenticado, *cuando* actualiza su contraseña cumpliendo la política mínima, *entonces* la nueva clave queda vigente y la sesión actual se mantiene mientras las demás se revocan.
- **AUTH-03** — Sesiones con expiración, cierre con revocación y timeout por inactividad. Medible: sesión expirada o revocada redirige al login en el siguiente request.
  - *Dado* una sesión expirada, inactiva más allá del timeout o cerrada, *cuando* se intenta cualquier acción, *entonces* se exige re-autenticación y el token anterior queda inválido.
- **AUTH-04** — Registro de usuarios solo por el administrador; no existe auto-registro público. Medible: 0 rutas públicas de creación de usuarios.
  - *Dado* un visitante sin sesión, *cuando* intenta acceder a cualquier endpoint de registro, *entonces* recibe denegación y el intento queda auditado.
- **AUTH-05** — Bloqueo temporal tras múltiples intentos fallidos (umbral: 5 intentos). Medible: al 5.º fallo consecutivo la cuenta se bloquea temporalmente.
  - *Dado* 5 intentos fallidos consecutivos, *cuando* llega un 6.º intento dentro de la ventana, *entonces* se rechaza aunque las credenciales sean correctas hasta que expire el bloqueo.
- **AUTH-06** — Recuperación de contraseña con token de un solo uso y vencimiento corto. Medible: token reutilizado o vencido es rechazado siempre.
  - *Dado* un token válido, *cuando* se usa una vez, *entonces* queda marcado como usado y cualquier reuso se rechaza.
- **AUTH-07** — Tres roles fijos: admin, empleado, caja; sin permisos granulares. Un usuario puede tener más de un rol. Medible: el menú y las rutas visibles corresponden exactamente al rol asignado.
  - *Dado* un usuario con rol caja, *cuando* ingresa, *entonces* ve solo caja/facturación y recibe 403 en rutas de admin.

Criterio global CA-AUTH: un usuario ingresa con su documento y ve solo su menú por rol; la clave inicial debe cambiarse; la sesión expira y redirige al login; 5 fallos bloquean; la recuperación usa token de un solo uso; el cierre revoca la sesión.

### 5.2 Administración (ADM)

- **ADM-01** — CRUD de sedes (nombre, dirección, teléfono, activa/inactiva). Medible: crear/desactivar una sede no afecta datos históricos.
  - *Dado* un admin, *cuando* desactiva una sede, *entonces* sus registros históricos permanecen consultables y no se permite operar sobre ella.
- **ADM-02** — CRUD de empleados vinculados a un usuario de acceso (documento, teléfono, cargo, código interno visible, esquema de sueldo, activo/inactivo con soft-delete). Desactivar no borra historial. Medible: 0 eliminaciones físicas de empleados.
- **ADM-03** — `employee_code`: texto opcional, cambiable, solo para empleados; único por sede solo cuando tiene valor (unicidad compuesta `sede_id` + `employee_code` donde no es nulo ni vacío). Medible: dos empleados de la misma sede pueden tener código vacío, nunca el mismo código con valor.
  - *Dado* dos empleados de la misma sede con código vacío, *cuando* se guarda, *entonces* se acepta; *dado* un código con valor duplicado en la misma sede, *cuando* se guarda, *entonces* se rechaza con error de unicidad.
- **ADM-04** — Asignación de rol (admin/empleado/caja) por usuario, incluyendo doble rol (p. ej. empleado + caja). Medible: el cambio de rol surte efecto en el siguiente login o refresh de sesión.
- **ADM-05** — Catálogo de servicios facturables (nombre, descripción, precio, `duracion_min`/`duracion_max` en minutos, sin duración única). Medible: todo servicio creado aparece como ítem facturable.
- **ADM-06** — Impuestos configurables por sede (código IVA/ICA/Rete/otro, nombre, porcentaje, activo/inactivo); inician todos inactivos en 0. Medible: impuesto inactivo suma 0 en factura.
  - *Dado* un impuesto inactivo en 0, *cuando* se factura, *entonces* el total no incluye ningún cargo por ese impuesto.
- **ADM-07** — Catálogo de métodos de pago de Colombia por sede (efectivo, transferencia normal/PSE, Nequi, Daviplata, Bre-B, tarjeta) con activo/inactivo. Medible: solo métodos activos aceptan cobros.
- **ADM-08** — Esquemas de sueldo por empleado: `pay_type` fijo/porcentaje/mixto + `salary_fixed` + `commission_percent`. El fijo se paga fijo; porcentaje/mixto se liquidan desde `invoice_items` del periodo. Medible: la liquidación de un fijo ignora facturación; la de un porcentual la requiere.

Criterio global CA-ADM: el admin crea y desactiva empleados con código cambiable; no hay códigos con valor repetidos por sede; el rol restringe acceso; el servicio creado es facturable; el impuesto activado se refleja y el inactivo no suma.

### 5.3 Inventario (INV)

- **INV-01** — CRUD de productos (SKU único, nombre, descripción, costo, precio de venta, stock inicial vía movimiento IN, stock mínimo). Medible: SKU duplicado se rechaza siempre.
- **INV-02** — Movimientos IN/OUT/ADJUST con motivo, cantidad, responsable y fecha. Medible: 100% de movimientos registran responsable y motivo.
- **INV-03** — El stock se recalcula exclusivamente por movimientos (kardex); las ventas generan OUT automáticamente. Medible: 0 ediciones directas de `stock_qty` fuera de movimientos.
- **INV-04** — El stock nunca queda negativo en una venta; alerta visible bajo el mínimo. Medible: venta con stock insuficiente se rechaza; producto bajo mínimo muestra alerta.
  - *Dado* un producto con stock 2, *cuando* se factura cantidad 3, *entonces* la factura se rechaza con error de stock insuficiente.
- **INV-05** — Búsqueda por nombre o código/SKU. Medible: búsqueda por fragmento de nombre o SKU devuelve el producto.

Criterio global CA-INV: crear producto y mover stock cuadra existencias; bajo mínimo hay alerta; la búsqueda funciona por nombre y código; todo movimiento tiene responsable; venta sin stock se rechaza.

### 5.4 Factura interna (FAC)

- **FAC-01** — Crear factura con ítems de tipo producto, servicio o personalizado (custom). Solo un origen por línea (producto O servicio O custom). Medible: factura con los 3 tipos calcula el total correctamente.
- **FAC-02** — Empleado asociado por línea (`employee_id`), base de participación/comisión. Medible: toda comisión de nómina traza a una línea de factura.
- **FAC-03** — Descuento por factura o por ítem, e impuestos configurables con snapshot por factura (`invoice_taxes` conserva código/nombre/porcentaje/monto aunque el catálogo cambie). Medible: cambiar el catálogo no altera facturas emitidas.
- **FAC-04** — Estados Emitida/Pagada/Anulada; solo transiciones permitidas; la anulación exige motivo, no borra el registro y queda auditada. Medible: 100% de anulaciones tienen motivo y entrada de auditoría.
  - *Dado* una factura Pagada, *cuando* se anula con motivo, *entonces* cambia a Anulada, conserva su consecutivo y genera reversión de stock según regla.
- **FAC-05** — Consecutivo automático por sede, sin huecos ni duplicados incluso con concurrencia. Medible: prueba de 10 emisiones concurrentes produce 10 consecutivos únicos y continuos.
- **FAC-06** — La factura con productos descuenta stock (OUT vinculado); la anulada lo revierte (IN vinculado). Medible: stock post-anulación igual al pre-factura.
- **FAC-07** — Un cobro puede dividirse en varias porciones, cada una con su método de pago (p. ej. parte efectivo + parte Nequi). La suma de porciones cuadra con el total. Medible: 0 cobros con suma distinta al total.

Criterio global CA-FAC: factura con 3 tipos de ítem calcula total con descuento e impuestos (inactivos = 0); estados solo por acciones permitidas; consecutivos únicos bajo concurrencia; anulación auditada con motivo; cobro dividido cuadra por método.

### 5.5 Caja multi-turno (CAJ)

- **CAJ-01** — Apertura y cierre de turnos por persona y jornada en la misma caja (varios turnos por día, sin solape: un solo turno abierto a la vez). La apertura registra `opening_base`, que viene de `base_left` del cierre anterior. Medible: la apertura N+1 siempre propone `base_left` del cierre N.
  - *Dado* un cierre anterior con `base_left` = 200 000, *cuando* se abre el siguiente turno, *entonces* `opening_base` = 200 000.
- **CAJ-02** — Pagos en los métodos del catálogo (efectivo, transferencia/PSE, Nequi, Daviplata, Bre-B, tarjeta si aplica), vinculados a factura y al turno abierto; cobro divisible por método. Medible: 0 pagos fuera de un turno abierto.
- **CAJ-03** — Cierre por turno con arqueo y conteo obligatorio de efectivo: `expected_cash` (cobrado en efectivo según el turno) vs `counted_cash` (contado físico); la diferencia queda registrada con quién abrió y quién cerró. No se puede cerrar sin conteo. Medible: 100% de cierres tienen `counted_cash` no nulo.
- **CAJ-04** — Base configurable por sede/caja (`base_configurada`, p. ej. 300 000). Al cierre se registra `base_left`, `cash_withdrawn` (= `counted_cash` − `base_left`), `base_difference` (= `base_left` − `base_configurada`: faltante/sobrante) y observación. Casos del negocio: (a) hay 400 000 y la base es 200 000 → quedan 200 000 de base y se recogen 200 000; (b) base configurada 300 000 pero solo hay 150 000 en efectivo → la base de la próxima apertura es 150 000 con faltante de 150 000. Si `base_left` < `base_configurada` queda marcada como base incompleta con observación obligatoria. Medible: 100% de bases incompletas tienen observación.
- **CAJ-05** — Vista del día: turnos/cierres con arqueo + acumulado (ventas, esperado, contado, base dejada, recogido, diferencias); el acumulado cuadra con la suma de turnos. Medible: acumulado siempre igual a la suma de turnos del día.
- **CAJ-06** — Historial de aperturas, movimientos, bases y cierres filtrable por fecha. Medible: filtro por fecha devuelve exactamente los turnos del rango.

Criterio global CA-CAJ: dos turnos del mismo día con responsables distintos, cada apertura usa la base anterior; pagos por método activo contra el turno; cierre exige conteo y muestra esperado vs contado; base incompleta exige observación; vista del día cuadra; historial filtra por fecha.

### 5.6 Nómina (PAY; códigos NOM del Word)

- **PAY-01 (NOM-01)** — Periodos de nómina por sede con fechas y estado borrador/cerrado; cerrado = inmutable; un solo borrador activo por sede y rango. Medible: periodo cerrado rechaza toda edición.
- **PAY-02 (NOM-02)** — Cálculo automático por empleado: `base_fixed` + `commissions` (desde `invoice_items` del periodo por `employee_id`) + `bonuses` − `deductions_vales` − `other_discounts` = `net_pay`. Medible: recalcular el periodo reproduce el mismo neto.
- **PAY-03 (NOM-03)** — Detalle justificable por factura e ítem (`detail_json`) con reporte que explica el valor liquidado. Medible: cada peso de comisión traza a una línea de factura.
- **PAY-04 (NOM-04)** — Un ítem de nómina se paga en varias porciones por método (efectivo, transferencia, descuento de vales), con `paid_at`/`paid_by`/`reference`. La suma de porciones cuadra con el neto. Medible: 0 ítems con pagos que excedan el neto.

Criterio global CA-NOM: un borrador calcula el neto de un empleado mixto desde sus ítems y muestra el reporte por factura; el pago en porciones suma el neto con fecha/método/responsable; el cierre deja vales descontados y bloquea edición.

### 5.7 Vales (PAY; códigos VAL del Word)

- **PAY-05 (VAL-01)** — Topes por sede: máximo por día y por semana (`voucher_settings`, un registro por sede). Medible: todo desembolso se valida contra ambos topes.
- **PAY-06 (VAL-02)** — Solicitudes con estado pendiente/aprobada/rechazada/descontada; superar topes exige aprobación del admin con código dinámico básico y observación opcional. Medible: 0 vales sobre tope sin `approved_by` + código.
  - *Dado* un vale que supera el tope diario, *cuando* se solicita, *entonces* queda pendiente y solo se aprueba con código del admin.
- **PAY-07 (VAL-03)** — Al liquidar la nómina, los vales pendientes/aprobados se descuentan (`deductions_vales`) y pasan a estado descontada. Medible: vale descontado dos veces es imposible (transición única).

### 5.8 Transversales (TRA)

- **TRA-01** — Auditoría de acciones críticas (crear/modificar/anular factura, pagos, movimientos, cierres, periodos, vales): quién, qué, cuándo, entidad. Medible: 100% de acciones críticas tienen entrada en `audit_logs`.
- **TRA-02** — Borrado lógico con `is_active`/`deleted_at`; nada crítico se elimina físicamente. Medible: 0 `DELETE` físicos en tablas de negocio desde la app.
- **TRA-03** — Toda tabla de negocio lleva `sede_id`, `created_at`, `updated_at` y PK UUID. Medible: revisión de esquema sin excepciones.

## 6. Requisitos no funcionales

| ID | Categoría | Requisito medible |
|---|---|---|
| NFR-01 | Rendimiento | Con 10 empleados concurrentes: p95 de lectura de listados < 1 s y de emisión de factura < 3 s en red estándar; emisión concurrente de 10 facturas sin duplicar consecutivos ni degradar stock. |
| NFR-02 | Seguridad (datos) | RLS deny-by-default en todas las tablas con `sede_id`: sin política no hay lectura/escritura. Cada usuario solo ve su sede. `service_role` únicamente en servidor (Server Actions/Route Handlers), nunca en cliente. |
| NFR-03 | Seguridad (app) | Validación Zod en servidor en todas las acciones de escritura (lo del navegador es solo ayuda visual). Cabeceras estándar (CSP, HSTS, X-Frame-Options, nosniff, referrer-policy). Rate-limit en login y recuperación + WAF de la plataforma. Secretos solo en variables de entorno. Tokens y claves solo como hash. |
| NFR-04 | Usabilidad | Flujos guiados (apertura → cobro → arqueo → cierre; periodo → liquidación → pago por porciones) con errores en lenguaje de negocio y sin códigos crudos. Alertas visibles de stock mínimo y base incompleta. |
| NFR-05 | Compatibilidad | Despliegue único en Vercel (front + back Next.js) con Supabase (Postgres + Auth + Storage). Sin servidores que administrar. Backups según plan (§11: automáticos solo en producción paga). |
| NFR-06 | Modo oscuro sin flash | `next-themes` + cookie leída en SSR + script inline en `<head>` que fija el tema antes del primer pintado + `suppressHydrationWarning`. Medible: 0 destellos del tema contrario al cargar/recargar en claro u oscuro. |
| NFR-07 | Confiabilidad | Transacciones atómicas en factura (ítems + impuestos + pagos + stock), cierre de turno y liquidación (ítems + descuentos de vales). Ante fallo, rollback completo y mensaje accionable. |
| NFR-08 | Mantenibilidad | Monolito modular por features (auth, admin, inventory, billing, cash, payroll/vouchers) con Server Actions tipadas y esquemas Zod versionados junto a cada feature. |

## 7. User stories

| ID | Historia | Prioridad | Criterio observable |
|---|---|---|---|
| US-01 | Como empleada, quiero ingresar con mi número de documento y clave propia para ver solo mi menú | Must | Login con documento; menú según rol; clave inicial obliga cambio |
| US-02 | Como admin, quiero crear usuarios y asignarles rol para controlar quién entra a cada módulo | Must | Solo admin crea; sin auto-registro; rol restringe rutas |
| US-03 | Como admin, quiero gestionar empleados con código interno opcional y esquema de sueldo para liquidar bien | Must | Código vacío permitido, con valor único por sede; sueldo fijo/%/mixto |
| US-04 | Como admin, quiero configurar servicios con duración mínima y máxima para facturarlos | Must | Servicio creado aparece como ítem facturable |
| US-05 | Como admin, quiero activar/desactivar impuestos y métodos de pago por sede para reflejar la realidad del negocio | Must | Impuesto activo suma, inactivo = 0; cobro solo con método activo |
| US-06 | Como encargada de inventario, quiero registrar entradas/salidas/ajustes con responsable para que el stock siempre cuadre | Must | Kardex completo; stock solo vía movimientos |
| US-07 | Como cajera, quiero facturar productos/servicios/personalizados con descuento e impuestos para cobrar exacto | Must | Total = subtotal − descuento + impuestos snapshot |
| US-08 | Como cajera, quiero dividir un cobro entre efectivo y Nequi para no perder la venta | Must | Porciones por método suman el total |
| US-09 | Como cajera, quiero abrir y cerrar mi turno con conteo de efectivo para entregar cuentas claras | Must | Cierre bloqueado sin conteo; esperado vs contado visible |
| US-10 | Como responsable, quiero ver la vista del día con el acumulado de turnos para verificar que todo cuadra | Must | Acumulado = suma de turnos |
| US-11 | Como admin, quiero liquidar la nómina por periodo con comisiones desde facturación para pagar lo justo | Must | Neto = base + comisiones + bonos − vales − otros; reporte por factura |
| US-12 | Como empleado, quiero pedir un vale y saber si necesita aprobación para recibirlo a tiempo | Must | Sobre tope exige aprobación con código |
| US-13 | Como admin, quiero pagar la nómina en porciones por método para adaptarme a la caja disponible | Should | Porciones suman el neto con fecha/método/responsable |
| US-14 | Como admin, quiero anular una factura con motivo y reversión de stock para corregir sin borrar historia | Must | Anulación auditada; stock revertido; consecutivo conservado |
| US-15 | Como auditora, quiero el historial de acciones críticas para saber quién hizo qué | Should | `audit_logs` consultable por entidad/fecha/usuario |

## 8. Flujos principales + alternos + edge

### F1 — Login con documento y cambio forzado la primera vez

1. Usuario ingresa `numero_identificacion` + contraseña. 2. Si es primera vez (clave = documento / flag `must_change_password`), se redirige a cambio de clave y se bloquea lo demás. 3. Nueva clave válida → se actualiza el hash, se marca el cambio, sesión activa con expiración y timeout.
- Alterno: 5 fallos → bloqueo temporal con mensaje y tiempo restante.
- Alterno: olvidó clave → token de un solo uso con vencimiento corto → nueva clave → token marcado usado.
- Edge: doble rol (empleado + caja) → menú combinado; sesión cerrada en otro dispositivo queda revocada.

### F2 — Cierre de caja con base incompleta

1. Turno abierto con `opening_base` heredada. 2. Durante el turno se registran pagos contra el turno. 3. Al cierre se ingresa `counted_cash` (obligatorio). 4. Sistema calcula esperado vs contado, propone `base_left` (por defecto = `base_configurada` si alcanza, si no el efectivo disponible), `cash_withdrawn` y `base_difference`. 5. Si `base_left` < `base_configurada` → marca base incompleta y exige observación (caso 300/150: base próxima = 150 000, faltante 150 000). 6. Caso 400/200: base 200 000, recogido 200 000. 7. Cierre registrado con `opened_by`/`closed_by`; siguiente apertura hereda `base_left`.
- Alterno: conteo mayor al esperado (sobrante) → diferencia positiva registrada, cierre permitido con observación.
- Edge: intento de abrir segundo turno con uno abierto → rechazo (sin solape). Edge: intento de cerrar sin conteo → bloqueo con mensaje.

### F3 — Nómina mixta con pago dividido y descuento de vales

1. Admin abre periodo borrador por sede y rango. 2. Sistema calcula por empleado: fijo + comisiones (agregado de `invoice_items` donde `employee_id` en el rango) + bonos − vales aprobados/pendientes − otros = neto, con `detail_json` por factura/ítem. 3. Reporte permite verificar cada peso. 4. Pago en porciones: p. ej. 40% efectivo + 40% transferencia + 20% descuento de vales; cada porción registra método/fecha/responsable/referencia. 5. Al cerrar, vales pasan a descontada y el periodo queda inmutable.
- Alterno: empleado solo fijo → sin reporte de comisiones, neto = base − descuentos.
- Edge: vale aprobado después del cálculo → recalcular borrador antes de cerrar; periodo cerrado rechaza recálculo.

### F4 — Vale que supera el tope con aprobación

1. Empleado solicita vale por monto/fecha. 2. Sistema valida contra `max_per_day`/`max_per_week` acumulando vales vigentes del periodo. 3. Si no supera → pendiente que el admin puede aprobar directo. 4. Si supera → pendiente con aprobación obligatoria: admin ingresa código dinámico básico + observación opcional → aprobada (o rechazada con motivo). 5. En liquidación se descuenta y marca descontada.
- Edge: dos solicitudes simultáneas que juntas superan el tope → la segunda exige aprobación. Edge: vale aprobado nunca descontado dos veces (transición de estado única y atómica).

## 9. Modelo de datos (complementado)

Convenciones globales (TRA-03): PK `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` salvo compuestas indicadas; toda tabla de negocio lleva `sede_id uuid NOT NULL REFERENCES sedes(id)`, `created_at timestamptz DEFAULT now()`, `updated_at timestamptz DEFAULT now()`, y soft-delete (`is_active boolean DEFAULT true`, `deleted_at timestamptz` donde aplique). Numéricos de dinero `numeric(12,2)`; cantidades enteras `int`. `updated_at` se mantiene con trigger.

### 9.1 Tablas por tabla (columna, tipo, constraints)

- **sedes**: `id` uuid PK; `name` text NOT NULL; `address` text; `phone` text; `is_active` boolean DEFAULT true.
- **users**: `id` uuid PK; `sede_id` uuid FK NOT NULL; `email` text UNIQUE NOT NULL; `phone` text; `tipo_identificacion` text NOT NULL CHECK (en CC/CE/PPT/PEP/otro); `numero_identificacion` text UNIQUE NOT NULL (username de acceso); `password_hash` text NOT NULL; `full_name` text NOT NULL; `must_change_password` boolean DEFAULT false; `failed_attempts` int DEFAULT 0 CHECK (>=0); `locked_until` timestamptz; `is_active` boolean; timestamps. Índices: unique (`numero_identificacion`), unique (`email`), index (`sede_id`).
- **roles**: `id` uuid PK; `code` text UNIQUE NOT NULL CHECK (en admin/empleado/caja); `description` text.
- **user_roles**: `user_id` uuid FK + `role_id` uuid FK, PK compuesta (`user_id`,`role_id`).
- **sessions** (incluye refresh): `id` uuid PK; `user_id` uuid FK NOT NULL; `token_hash` text UNIQUE NOT NULL; `expires_at` timestamptz NOT NULL; `revoked` boolean DEFAULT false; `last_activity_at` timestamptz; `created_at`. Índice (`user_id`), índice (`token_hash`).
- **password_resets**: `id` uuid PK; `user_id` uuid FK NOT NULL; `token_hash` text UNIQUE NOT NULL; `expires_at` timestamptz NOT NULL; `used` boolean DEFAULT false; `created_at`. CHECK (`expires_at` > `created_at`).
- **employees**: `id` uuid PK (llave técnica); `user_id` uuid FK UNIQUE NOT NULL; `sede_id` uuid FK NOT NULL; `employee_code` text (nullable, vacío permitido, cambiable, solo empleados); `document` text NOT NULL; `phone` text; `position` text; `pay_type` text NOT NULL CHECK (en fijo/porcentaje/mixto); `salary_fixed` numeric(12,2) CHECK (>=0); `commission_percent` numeric(5,2) CHECK (0–100); `is_active` boolean; timestamps. Unique parcial sede+code con valor (ver DDL §9.3).
- **services**: `id` uuid PK; `sede_id` FK; `name` text NOT NULL; `description` text; `price` numeric(12,2) NOT NULL CHECK (>=0); `duracion_min` int NOT NULL CHECK (>=0); `duracion_max` int NOT NULL CHECK (>=0); CHECK (`duracion_min` <= `duracion_max`); `is_active` boolean; timestamps.
- **products**: `id` uuid PK; `sede_id` FK; `sku` text UNIQUE NOT NULL; `name` text NOT NULL; `description` text; `stock_qty` int NOT NULL DEFAULT 0 CHECK (>=0); `min_stock` int NOT NULL DEFAULT 0 CHECK (>=0); `cost_price` numeric(12,2) CHECK (>=0); `sale_price` numeric(12,2) CHECK (>=0); `is_active` boolean; timestamps. Índices: (`sku`), trigram/prefijo en (`name`).
- **inventory_movements**: `id` uuid PK; `product_id` uuid FK NOT NULL; `sede_id` FK; `type` text CHECK (en IN/OUT/ADJUST); `qty` int NOT NULL CHECK (>0); `reason` text NOT NULL; `user_id` uuid FK NOT NULL; `created_at`. Índices (`product_id`,`created_at`), (`sede_id`).
- **tax_configs**: `id` uuid PK; `sede_id` FK; `code` text NOT NULL CHECK (en IVA/ICA/Rete/otro); `name` text NOT NULL; `percent` numeric(5,2) NOT NULL CHECK (0–100); `is_active` boolean DEFAULT false; timestamps. Inician todos inactivos en 0. Unique (`sede_id`,`code`,`name`).
- **invoices**: `id` uuid PK; `sede_id` FK; `consecutive_number` int NOT NULL; `client_name` text NOT NULL; `client_document` text; `subtotal`/`discount`/`tax`/`total` numeric(12,2) CHECK (>=0); CHECK (`total` = `subtotal` − `discount` + `tax` con tolerancia de redondeo); `status` text CHECK (en Emitida/Pagada/Anulada); `user_id` FK; `cash_register_id` FK; `cancel_reason` text; timestamps. Unique (`sede_id`,`consecutive_number`). Índice (`sede_id`,`status`,`created_at`).
- **invoice_items**: `id` uuid PK; `invoice_id` FK NOT NULL; `item_type` text CHECK (en producto/servicio/custom); `product_id`/`service_id`/`employee_id` FKs nullables; `custom_name` text; `qty` int CHECK (>0); `unit_price` numeric(12,2) CHECK (>=0); `discount` numeric(12,2) DEFAULT 0 CHECK (>=0); `subtotal` numeric(12,2) CHECK (>=0); CHECK (solo un origen: exactamente uno de `product_id`/`service_id`/`custom_name` no nulo). Índice (`invoice_id`), índice (`employee_id`,`invoice_id`) para nómina.
- **invoice_taxes**: `id` uuid PK; `invoice_id` FK NOT NULL; `tax_code` text NOT NULL; `tax_name` text NOT NULL; `percent` numeric(5,2) CHECK (0–100); `amount` numeric(12,2) CHECK (>=0). Snapshot inmutable.
- **cash_registers**: `id` uuid PK; `sede_id` FK; `name` text DEFAULT 'Caja única'; `base_configurada` numeric(12,2) NOT NULL CHECK (>=0) (p. ej. 300 000); `is_open` boolean DEFAULT false; timestamps.
- **cash_shifts**: `id` uuid PK; `cash_register_id` FK NOT NULL; `sede_id` FK; `opened_by`/`closed_by` FK users (closed nullable); `opened_at`/`closed_at` timestamptz; `opening_base` numeric(12,2) NOT NULL CHECK (>=0); `expected_cash`/`counted_cash`/`base_left`/`cash_withdrawn`/`base_difference` numeric(12,2) (contado y derivados nullables hasta el cierre); `observation` text; `status` text CHECK (en abierto/cerrado); CHECK (`cash_withdrawn` = `counted_cash` − `base_left` cuando cerrado); CHECK (`base_difference` = `base_left` − base configurada vigente); CHECK (si `base_left` < base configurada → `observation` obligatoria y marca base incompleta); exclusión de solape: un solo turno abierto por caja (índice unique parcial donde status = abierto). Índices (`cash_register_id`,`opened_at`), (`sede_id`,`opened_at`).
- **payment_methods**: `id` uuid PK; `sede_id` FK; `code` text CHECK (en efectivo/transferencia_normal/Nequi/Daviplata/Bre-B/tarjeta); `name` text NOT NULL; `is_active` boolean DEFAULT true; timestamps. Unique (`sede_id`,`code`).
- **payments**: `id` uuid PK; `cash_shift_id` FK NOT NULL; `invoice_id` FK (nullable para ajustes documentados); `method_id` FK NOT NULL; `method_code` text NOT NULL (snapshot); `amount` numeric(12,2) CHECK (>0); `user_id` FK; `created_at`. Índice (`cash_shift_id`), (`invoice_id`).
- **payroll_periods**: `id` uuid PK; `sede_id` FK; `start_date`/`end_date` date NOT NULL; CHECK (`start_date` <= `end_date`); `status` text CHECK (en borrador/cerrado); timestamps. Unique parcial: un solo borrador por sede y rango (índice unique donde status = borrador).
- **payroll_items**: `id` uuid PK; `period_id` FK NOT NULL; `employee_id` FK NOT NULL; `base_fixed`/`commissions`/`bonuses`/`deductions_vales`/`other_discounts`/`net_pay` numeric(12,2) CHECK (>=0 salvo descuentos que restan); CHECK (`net_pay` = base + comisiones + bonos − vales − otros); `detail_json` jsonb NOT NULL (líneas por factura/ítem); Unique (`period_id`,`employee_id`).
- **payroll_payments**: `id` uuid PK; `payroll_item_id` FK NOT NULL; `method_id` FK NOT NULL; `method_code` text NOT NULL; `amount` numeric(12,2) CHECK (>0); `paid_at` timestamptz NOT NULL; `paid_by` FK users NOT NULL; `reference` text. La suma por ítem no excede `net_pay` (validación en servidor + trigger).
- **voucher_settings**: `sede_id` uuid PK FK (un registro por sede); `max_per_day`/`max_per_week` numeric(12,2) CHECK (>=0).
- **voucher_requests**: `id` uuid PK; `employee_id` FK NOT NULL; `sede_id` FK; `amount` numeric(12,2) CHECK (>0); `request_date` date NOT NULL; `status` text CHECK (en pendiente/aprobada/rechazada/descontada); `approved_by` FK users nullable; `approval_code` text (obligatorio si superó topes); `observation` text; timestamps. CHECK (si `status` en aprobada/descontada y superó tope → `approved_by` y `approval_code` no nulos). Transiciones únicas: descontada es terminal. Índices (`employee_id`,`request_date`), (`sede_id`,`status`).
- **audit_logs**: `id` uuid PK; `sede_id` FK; `user_id` FK; `action` text NOT NULL; `entity` text NOT NULL; `entity_id` uuid NOT NULL; `metadata` jsonb; `created_at`. Solo acciones críticas. Índice (`entity`,`entity_id`), (`sede_id`,`created_at`).

### 9.2 Índices (resumen)

PKs y FKs indexadas en todos los listados; uniques: `users.email`, `users.numero_identificacion`, `products.sku`, `invoices(sede_id, consecutive_number)`, `payment_methods(sede_id, code)`, `payroll_items(period_id, employee_id)`; parciales críticos: `employees(sede_id, employee_code)` solo con valor, un turno abierto por caja, un borrador de nómina por sede/rango (ver DDL). Búsqueda: `products(name, sku)`.

### 9.3 DDL resumido — solo lo crítico (no son migraciones completas)

```sql
-- Unicidad de código de empleado solo cuando tiene valor (vacío/nulo se permite repetir)
CREATE UNIQUE INDEX uq_employees_sede_code
  ON employees (sede_id, employee_code)
  WHERE employee_code IS NOT NULL AND btrim(employee_code) <> '';

-- Un solo turno abierto por caja (sin solape)
CREATE UNIQUE INDEX uq_cash_shifts_open_per_register
  ON cash_shifts (cash_register_id)
  WHERE status = 'abierto';

-- Un solo periodo borrador por sede y rango
CREATE UNIQUE INDEX uq_payroll_draft_per_range
  ON payroll_periods (sede_id, start_date, end_date)
  WHERE status = 'borrador';

-- RLS activado (deny-by-default; políticas por sede/rol en §9.4)
ALTER TABLE sedes ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_taxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_registers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
```

### 9.4 Políticas RLS por sede/rol (una tabla)

| Tabla(s) | Admin | Empleado / Caja | Regla base |
|---|---|---|---|
| sedes, tax_configs, payment_methods, voucher_settings | CRUD en su sede | Solo lectura de catálogos activos de su sede | `sede_id` = sede del usuario (JWT/app claim); denegado por defecto |
| users, user_roles, employees | CRUD en su sede | Lectura propia (su `user_id`/empleado); sin crear usuarios | Solo filas de su `sede_id`; escritura solo rol admin |
| sessions, password_resets | Gestión (revocar) en su sede | Solo propias | Titularidad + sede |
| products, services | CRUD en su sede | Lectura + uso en factura; movimientos según rol (caja vende, inventario ajusta) | Sede propia; OUT por venta exige stock |
| inventory_movements | Lectura/ajuste total en su sede | Crear IN/OUT por venta o ajuste autorizado; sin editar historial | Insert-only para no-admin (sin UPDATE/DELETE) |
| invoices, invoice_items, invoice_taxes | CRUD + anular en su sede | Crear/cobrar en su sede; anular solo admin | Sede propia; anulación con motivo + auditoría |
| cash_registers, cash_shifts | Configurar base + ver todo en su sede | Abrir/cerrar sus turnos; ver día e historial de su sede | Un turno abierto por caja; cierre exige conteo |
| payments | Ver/anular con motivo en su sede | Registrar contra turno abierto de su sede | Atado a turno + factura; suma cuadra |
| payroll_periods, payroll_items, payroll_payments | Liquidar/cerrar/pagar en su sede | Empleado ve solo sus ítems y pagos | Periodo cerrado inmutable |
| voucher_requests | Aprobar/rechazar en su sede | Crear propias; ver propias | Sobre tope exige `approved_by` + código |
| audit_logs | Lectura en su sede | Sin escritura directa (solo vía sistema) | Insert solo desde servidor |

## 10. API-first / Server Actions por módulo (validación Zod server-side)

Principio API-first (futura app sin reestructurar): la lógica vive en servicios compartidos del servidor; el web la usa vía Server Actions y la futura app vía REST versionada. Mismo servicio, misma validación Zod, mismo chequeo rol/sede y auditoría. Nombres orientativos; el contrato que importa es la validación.

**REST v1 para la futura app**: base `/api/v1`, auth con JWT de Supabase (Bearer), `sede_id` por RLS/claims, versionado por path (`/v2` rompe solo lo necesario), paginación `?page&limit`, errores `{success:false, code, message}` y OpenAPI publicado desde los esquemas Zod.

| Módulo | Método + path | Usa el mismo servicio que | Auth/alcance |
|---|---|---|---|
| Auth | `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `POST /api/v1/auth/password:change`, `POST /api/v1/auth/password-reset:request`, `POST /api/v1/auth/password-reset:confirm` | `login/logout/changePassword/requestPasswordReset/resetPassword` | Público con rate-limit + bloqueo tras 5 intentos; resto con sesión |
| Admin | `GET/POST /api/v1/employees`, `GET/PATCH /api/v1/employees/:id`, `GET/POST /api/v1/services`, `GET/POST /api/v1/taxes`, `GET/POST /api/v1/payment-methods` | `upsertEmployee/upsertService/upsertTaxConfig/upsertPaymentMethod/setUserRoles` | Admin para escribir; empleado lee catálogos de su sede |
| Inventario | `GET/POST /api/v1/products`, `POST /api/v1/inventory/movements`, `GET /api/v1/products:search` | `upsertProduct/registerMovement/searchProducts` | Sede propia; OUT nunca deja stock negativo |
| Factura | `POST /api/v1/invoices`, `POST /api/v1/invoices/:id/annul`, `POST /api/v1/invoices/:id/payments:split` | `createInvoice/annulInvoice/splitPayment` | Consecutivo por sede, snapshot de impuestos, reversión de stock |
| Caja | `POST /api/v1/cash-shifts:open`, `POST /api/v1/cash-shifts/:id/close`, `GET /api/v1/cash/day?fecha=`, `POST /api/v1/cash/payments` | `openShift/closeShift/getDayView/registerPayment` | Un turno abierto por caja; cierre exige conteo |
| Nómina/vales | `POST /api/v1/payroll-periods`, `POST /api/v1/payroll-periods/:id/calculate`, `POST /api/v1/payroll-items/:id/payments`, `POST /api/v1/payroll-periods/:id/close`, `POST /api/v1/vouchers`, `POST /api/v1/vouchers/:id/approve` | `openPayrollPeriod/calculatePayroll/payPayrollItem/closePayrollPeriod/requestVoucher/approveVoucher` | Sobre tope exige `approved_by` + código; periodo cerrado inmutable |

- **Auth**: `login({documento, password})` (rate-limit, contador de intentos, bloqueo tras 5, flag cambio forzado); `logout()` (revoca sesión); `changePassword({actual, nueva})` (política mínima, revoca otras sesiones); `adminCreateUser({datos + rol + sede})` (solo admin); `requestPasswordReset({documento})` + `resetPassword({token, nueva})` (token hash, un solo uso, expiración corta).
- **Admin**: `upsertSede`, `upsertEmployee` (valida unicidad parcial de `employee_code`, `pay_type` + fijo/porcentaje coherentes), `setUserRoles`, `upsertService` (`duracion_min` <= `duracion_max`), `upsertTaxConfig` (percent 0–100), `upsertPaymentMethod` (código del catálogo Colombia).
- **Inventory**: `upsertProduct` (SKU único, precios/stock >= 0), `registerMovement({product_id, type, qty>0, reason})` (nunca deja stock negativo en OUT), `searchProducts({q})`.
- **Billing**: `createInvoice({cliente, items[producto|servicio|custom + employee_id?], discount, turno})` transaccional (consecutivo por sede bajo lock, snapshot de impuestos activos, OUT de stock, porciones de pago que cuadran); `annulInvoice({id, motivo})` (reversión de stock + auditoría); `splitPayment({invoice_id, porciones[]})`.
- **Cash**: `openShift({caja})` (hereda `base_left` anterior, rechaza si hay turno abierto); `registerPayment({turno, factura, método, monto})` (método activo, turno abierto); `closeShift({turno, counted_cash, base_left, observation})` (conteo obligatorio, observación obligatoria si base incompleta, calcula recogido/diferencia); `getDayView({fecha})`, `getHistory({rango})`.
- **Payroll/Vouchers**: `openPayrollPeriod`, `calculatePayroll({periodo})` (agrega `invoice_items` por empleado en rango → `detail_json`), `payPayrollItem({item, porciones[]})` (suma = neto), `closePayrollPeriod` (inmutable + vales a descontada); `setVoucherLimits`, `requestVoucher`, `approveVoucher({id, código, observación})` (obligatorio sobre topes), `rejectVoucher`.
- **Transversal**: `writeAudit` interno (toda acción crítica), validación común `requireSedeRole(roles[])` + `assertDraftPeriod` / `assertOpenShift`.

## 11. Seguridad + costos + métricas y aceptación global

**Seguridad (resumen operativo)**: RLS deny-by-default con `sede_id` en todo; `service_role` solo en servidor; Zod server-side siempre; cabeceras estándar + rate-limit en login/recuperación + WAF de la plataforma; secretos en env; hashes para claves y tokens; auditoría de acciones críticas; backups según plan de abajo.

**Costos 2026 (referencia, verificar páginas oficiales antes de contratar)**:

| Etapa | Combinación | Costo/mes | Qué obtiene al pagar |
|---|---|---|---|
| Desarrollo MVP | Vercel Hobby + Supabase Free | $0 | Velocidad sin costo: despliegues, login, base y storage para construir y probar. Sin backups ni garantías; la base se pausa tras ~1 semana inactiva. |
| Producción inicial | Vercel Hobby + Supabase Pro (1 proyecto) | ~$25 | Base productiva mínima: sin pausa, backups diarios de 7 días, 8 GB por proyecto y límites ampliados. |
| Producción con equipo | Vercel Pro (1 puesto) + Supabase Pro | ~$25–45 | Colaboración, más transferencia/requests, protección mejorada y soporte; el margen depende del uso real. |

Nómina y vales no cambian estos precios: usan la misma base y el mismo despliegue. Precios públicos de referencia; pueden variar por región e impuestos.

**Métricas de éxito del MVP**:

1. 100% requisitos Must aceptados según sus criterios Dado/Cuando/Entonces.
2. 0 consecutivos duplicados o con hueco bajo concurrencia; 0 ventas con stock negativo.
3. 100% cierres con conteo; 100% bases incompletas con observación; acumulado del día = suma de turnos.
4. 100% netos de nómina reproducibles desde `detail_json`; 0 vales sobre tope sin aprobación; 0 pagos que excedan el neto.
5. p95 de listados < 1 s y factura < 3 s con 10 empleados; 0 flashes de tema contrario.

**Criterios de aceptación global**: el MVP se acepta cuando las 5 métricas se cumplen en el despliegue de producción con datos de prueba del negocio (10 empleados, servicios con duración min/max, impuestos en 0 con 1 activación de prueba, 6 métodos de pago, 2 turnos/día con casos 400/200 y 300/150, 1 periodo de nómina mixta con pago dividido y 1 vale sobre tope aprobado).

## 12. Plan de implementación por orden (sin fechas comprometidas)

1. **Auth** (base de todo): users/roles/user_roles/sessions/password_resets + login con documento, cambio forzado, bloqueo, recuperación, RLS por sede. Depende de: nada. Desbloquea: todo.
2. **Admin** (catálogos): sedes/employees (con unicidad parcial de `employee_code`)/services (min/max)/tax_configs/payment_methods + sueldos fijo/%/mixto. Depende de: Auth. Desbloquea: inventario, facturación, nómina.
3. **Inventory** (kardex): products/inventory_movements + regla no-negativo + alertas + búsqueda. Depende de: Admin. Desbloquea: facturación con stock.
4. **Billing** (factura interna): invoices/invoice_items/invoice_taxes + consecutivo por sede + snapshot + anulación con reversión + cobro dividido. Depende de: Admin, Inventory. Desbloquea: caja y nómina.
5. **Cash** (multi-turno): cash_registers/cash_shifts/payments + base encadenada + arqueo + vista del día + historial. Depende de: Billing (pagos contra factura) y Admin (métodos). Desbloquea: operación diaria.
6. **Payroll/Vouchers** (contable): payroll_periods/items/payments + voucher_settings/requests + cálculo desde facturación + pago por porciones + topes y aprobación. Depende de: Billing (líneas por empleado), Cash (métodos), Admin (empleados). Cierra el MVP.
7. **Endurecimiento y salida**: RLS final + auditoría + rate-limit/headers + modo oscuro sin flash + pruebas de concurrencia (consecutivos, stock, solape de turnos, doble descuento de vales) + aceptación global (§11).

---
*Fuente funcional: `MVP_Orabella_Rebuild.docx` (2026-09-17). Todo su contenido queda cubierto en este PRD; lo técnico (§9–§10) cierra lo que el Word dejaba abierto para implementar sin adivinar.*
