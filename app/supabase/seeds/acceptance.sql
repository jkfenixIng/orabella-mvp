-- acceptance.sql — Seeds de aceptación global §11 (T8).
--
-- Criterio §11: "datos de prueba del negocio (10 empleados, servicios con
-- duración min/max, impuestos en 0 con 1 activación de prueba, 6 métodos de
-- pago, 2 turnos/día con casos 400/200 y 300/150, 1 periodo de nómina mixta
-- con pago dividido y 1 vale sobre tope aprobado)".
--
-- Este seed deja la BASE (sede, catálogos, empleados, caja lista); los turnos,
-- facturas, periodos y vales se crean por UI/flujos (ver README). NO incluye
-- datos de clientes reales: todos los nombres son ficticios colombianos y los
-- correos usan el dominio reservado ejemplo.co.
--
-- IDEMPOTENTE: re-ejecutable sin duplicar (ON CONFLICT DO NOTHING / DO UPDATE
-- donde hay unique, WHERE NOT EXISTS donde no lo hay).
-- Orden de aplicación: migraciones 001 → 008 primero, luego este seed.

DO $$
DECLARE
  v_sede uuid;
  v_admin uuid;
BEGIN
  -- ---------------------------------------------------------- sede (una) ---
  INSERT INTO public.sedes (name, address, phone)
  SELECT 'Sede principal', 'Calle 123 #45-67, Bogotá', '6015550134'
  WHERE NOT EXISTS (SELECT 1 FROM public.sedes WHERE name = 'Sede principal');

  SELECT id INTO v_sede FROM public.sedes WHERE name = 'Sede principal' LIMIT 1;

  -- ------------------------------------------------- usuarios (10, ficticios) ---
  -- Clave inicial = documento con cambio forzado (AUTH-01); hashes scrypt
  -- generados con el mismo formato de src/features/auth/service.ts.
  INSERT INTO public.users (sede_id, email, phone, id_type, id_number, password_hash, full_name, must_change_password) VALUES
    (v_sede, 'carolina.rojas@ejemplo.co', '3001110101', 'CC', '10000001', 'scrypt$v1$69acededf17b680588168930de483177$9921a732fc19f29e6638657b595df1bf2e39ffb8c9ffc1fbfea5add51c62ca5f5d1890d976afcf036e137bc6a03c60b46bb39b05f3558174afe0fe0ec36484ef', 'Carolina Rojas', true),
    (v_sede, 'diego.mejia@ejemplo.co', '3001110102', 'CC', '10000002', 'scrypt$v1$006ddd7f24bb4f8f31f0d6f67c683c0f$d466efa1e6bebfa47c17d39902c976a65945968815129250ff7bd68e9685aeaf753eb3c19400efc69dcd6af893475dc6186a4160d77492740a380051a125097d', 'Diego Mejía', true),
    (v_sede, 'paola.cifuentes@ejemplo.co', '3001110103', 'CC', '10000003', 'scrypt$v1$af6196d1e030a7498c6bdbd9bff06143$92e97f572b28d3107e01d8f074a7d557014a2ec92b36b3efa75fd6d65785980259b4e3a5c5f4921e11de636b196ece1456ec1afeae447eeb54d89ce318a2ca99', 'Paola Cifuentes', true),
    (v_sede, 'andres.quintero@ejemplo.co', '3001110104', 'CC', '10000004', 'scrypt$v1$b2a8266d8161152350b363ae0b4cfc95$7deae194e262aba38e03e4dd26d5cb5fb456122067231f14fcbef14e00df36e74057fcdeab6649e2612f4c6bab67aeb2134747af144dae5354d176d22cefc097', 'Andrés Quintero', true),
    (v_sede, 'lucia.herrera@ejemplo.co', '3001110105', 'CC', '10000005', 'scrypt$v1$1f279aa26ec25aaf7a9fa931d8c59a10$34825f1d62ee2de62fdc0a17f1258becec7119eca25d52b557e5b9cb512330bbfc5c8269ed3259eba7aed7b42cbeb01800658c72ac91a9161447a058b13c14a1', 'Lucía Herrera', true),
    (v_sede, 'marco.ospina@ejemplo.co', '3001110106', 'CC', '10000006', 'scrypt$v1$01f3f819f401e92eb102621e717e40f1$cbbf38a883c58da92d2afbb92224931a78fbdd44133a9dd28a6234e86ab829884a5bb048f7cc122f0fd38b84db2dcff3e02759fd9389a4f9071044a848fa60b', 'Marco Ospina', true),
    (v_sede, 'elena.vargas@ejemplo.co', '3001110107', 'CC', '10000007', 'scrypt$v1$72af6d5b10a65bbb560a00df3bcaf1ea$ef5ae6ddab4793a3f2d9a920c7c257577da66256f824a63f880db5dad39b6c42193175011777bf78e15bf6e5da02f474001a582061d87eb014267f72830837c', 'Elena Vargas', true),
    (v_sede, 'jorge.ramirez@ejemplo.co', '3001110108', 'CC', '10000008', 'scrypt$v1$b7fa6943a0155e2134c596b885639927$d4552c41c5c2933a2fe531bfbf68af059eb937a583bcb3c8e32ee720824f6fb9cbe087dd5a297de4df8e618cb2e12b31c64056426310b1a663391b0317a58480', 'Jorge Ramírez', true),
    (v_sede, 'natalia.pardo@ejemplo.co', '3001110109', 'CC', '10000009', 'scrypt$v1$a4961c06ecdd0a609e227527b9c6fa53$0fc8dfe6d9fedeef91626fa9b0a4cbddbfd56a56d50e26255da8968001bf2044131f4d1a4cdfe960d4d67de34fe17fac10c058466da31d4cd008b9f3e3c632d5', 'Natalia Pardo', true),
    (v_sede, 'sonia.morales@ejemplo.co', '3001110113', 'CC', '10000013', 'scrypt$v1$f860084ccb51c9801680c30b43669f88$75b31019e3b60a516639636ce7195d7afffe28bd819031d29ac8ba1a5206b51bbbaae5345d45a141ceaf6c0fed4c5f37389677c48ab851a7c1d491e2b5d612e3', 'Sonia Morales', true)
  ON CONFLICT (id_number) DO NOTHING;

  -- Roles: 1 admin (Carolina), Sonia con doble rol empleado+caja (edge F1),
  -- resto repartido entre empleado y caja.
  INSERT INTO public.user_roles (user_id, role_id)
  SELECT u.id, r.id FROM public.users u, public.roles r
  WHERE u.id_number = '10000001' AND r.code = 'admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.user_roles (user_id, role_id)
  SELECT u.id, r.id FROM public.users u, public.roles r
  WHERE u.id_number IN ('10000002', '10000003', '10000004', '10000005', '10000006') AND r.code = 'empleado'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.user_roles (user_id, role_id)
  SELECT u.id, r.id FROM public.users u, public.roles r
  WHERE u.id_number IN ('10000007', '10000008', '10000009') AND r.code = 'caja'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.user_roles (user_id, role_id)
  SELECT u.id, r.id FROM public.users u, public.roles r
  WHERE u.id_number = '10000013' AND r.code IN ('empleado', 'caja')
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_admin FROM public.users WHERE id_number = '10000001' LIMIT 1;

  -- --------------------------------------- empleados (10, Sonia mixta '13') ---
  -- Códigos con valor únicos por sede; dos sin código (NULL y vacío) para
  -- ejercitar la unicidad parcial ADM-03.
  INSERT INTO public.employees (sede_id, user_id, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, '01', '10000001', '3001110101', 'Administradora', 'fijo', 1500000, NULL FROM public.users u WHERE u.id_number = '10000001'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, '02', '10000002', '3001110102', 'Estilista', 'porcentaje', NULL, 30 FROM public.users u WHERE u.id_number = '10000002'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, '03', '10000003', '3001110103', 'Manicurista', 'mixto', 800000, 20 FROM public.users u WHERE u.id_number = '10000003'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, '04', '10000004', '3001110104', 'Barbero', 'porcentaje', NULL, 35 FROM public.users u WHERE u.id_number = '10000004'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, NULL, '10000005', '3001110105', 'Recepcionista', 'fijo', 1300000, NULL FROM public.users u WHERE u.id_number = '10000005'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, '', '10000006', '3001110106', 'Auxiliar', 'fijo', 1200000, NULL FROM public.users u WHERE u.id_number = '10000006'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, '07', '10000007', '3001110107', 'Cajera', 'fijo', 1400000, NULL FROM public.users u WHERE u.id_number = '10000007'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, '08', '10000008', '3001110108', 'Cajero', 'fijo', 1400000, NULL FROM public.users u WHERE u.id_number = '10000008'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, '09', '10000009', '3001110109', 'Colorista', 'mixto', 900000, 25 FROM public.users u WHERE u.id_number = '10000009'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, '13', '10000013', '3001110113', 'Estilista senior', 'mixto', 1000000, 30 FROM public.users u WHERE u.id_number = '10000013'
  ON CONFLICT (user_id) DO NOTHING;

  -- ----------------------------------------------- servicios (4, min/max) ---
  INSERT INTO public.services (sede_id, name, description, price, duracion_min, duracion_max)
  SELECT v_sede, 'Corte de cabello', 'Corte unisex con acabado', 35000, 30, 45
  WHERE NOT EXISTS (SELECT 1 FROM public.services WHERE sede_id = v_sede AND name = 'Corte de cabello');

  INSERT INTO public.services (sede_id, name, description, price, duracion_min, duracion_max)
  SELECT v_sede, 'Tinte completo', 'Coloración con producto incluido', 120000, 90, 150
  WHERE NOT EXISTS (SELECT 1 FROM public.services WHERE sede_id = v_sede AND name = 'Tinte completo');

  INSERT INTO public.services (sede_id, name, description, price, duracion_min, duracion_max)
  SELECT v_sede, 'Manicura', 'Manicura tradicional', 30000, 30, 60
  WHERE NOT EXISTS (SELECT 1 FROM public.services WHERE sede_id = v_sede AND name = 'Manicura');

  INSERT INTO public.services (sede_id, name, description, price, duracion_min, duracion_max)
  SELECT v_sede, 'Peinado fiesta', 'Peinado para eventos', 50000, 40, 60
  WHERE NOT EXISTS (SELECT 1 FROM public.services WHERE sede_id = v_sede AND name = 'Peinado fiesta');

  -- -------------------------------------- productos (3, stock vía IN) ---
  INSERT INTO public.products (sede_id, sku, name, description, min_stock, cost_price, sale_price)
  VALUES
    (v_sede, 'SH-500', 'Shampoo 500ml', 'Shampoo uso profesional', 5, 18000, 28000),
    (v_sede, 'TN-250', 'Tinte rubio 250ml', 'Tinte permanente', 10, 25000, 42000),
    (v_sede, 'ES-100', 'Esmalte rojo 100ml', 'Esmalte tradicional', 8, 9000, 15000)
  ON CONFLICT (sede_id, sku) DO NOTHING;

  -- Stock inicial SOLO vía movimientos IN (INV-03); el motivo fijo hace el
  -- seed re-ejecutable sin duplicar (el trigger suma al stock).
  -- TN-250 entra con 3 (< mínimo 10) para ejercitar la alerta de mínimo.
  INSERT INTO public.inventory_movements (sede_id, product_id, type, qty, reason, user_id)
  SELECT v_sede, p.id, 'IN', 20, 'SEED aceptación §11: stock inicial', v_admin
  FROM public.products p WHERE p.sede_id = v_sede AND p.sku = 'SH-500'
  AND NOT EXISTS (
    SELECT 1 FROM public.inventory_movements m
    WHERE m.product_id = p.id AND m.reason = 'SEED aceptación §11: stock inicial'
  );

  INSERT INTO public.inventory_movements (sede_id, product_id, type, qty, reason, user_id)
  SELECT v_sede, p.id, 'IN', 3, 'SEED aceptación §11: stock inicial', v_admin
  FROM public.products p WHERE p.sede_id = v_sede AND p.sku = 'TN-250'
  AND NOT EXISTS (
    SELECT 1 FROM public.inventory_movements m
    WHERE m.product_id = p.id AND m.reason = 'SEED aceptación §11: stock inicial'
  );

  INSERT INTO public.inventory_movements (sede_id, product_id, type, qty, reason, user_id)
  SELECT v_sede, p.id, 'IN', 12, 'SEED aceptación §11: stock inicial', v_admin
  FROM public.products p WHERE p.sede_id = v_sede AND p.sku = 'ES-100'
  AND NOT EXISTS (
    SELECT 1 FROM public.inventory_movements m
    WHERE m.product_id = p.id AND m.reason = 'SEED aceptación §11: stock inicial'
  );

  -- ------------------ impuestos (IVA 19% activado de prueba + ICA inactivo) ---
  INSERT INTO public.tax_configs (sede_id, code, name, percent, is_active)
  VALUES (v_sede, 'IVA', 'IVA general', 19, true)
  ON CONFLICT (sede_id, code, name)
  DO UPDATE SET percent = EXCLUDED.percent, is_active = EXCLUDED.is_active, updated_at = now();

  INSERT INTO public.tax_configs (sede_id, code, name, percent, is_active)
  VALUES (v_sede, 'ICA', 'ICA', 0, false)
  ON CONFLICT (sede_id, code, name)
  DO UPDATE SET percent = EXCLUDED.percent, is_active = EXCLUDED.is_active, updated_at = now();

  -- ------------------------------------------- métodos de pago (6, activos) ---
  INSERT INTO public.payment_methods (sede_id, code, name, is_active)
  VALUES
    (v_sede, 'efectivo', 'Efectivo', true),
    (v_sede, 'transferencia_normal', 'Transferencia / PSE', true),
    (v_sede, 'nequi', 'Nequi', true),
    (v_sede, 'daviplata', 'Daviplata', true),
    (v_sede, 'bre-b', 'Bre-B', true),
    (v_sede, 'tarjeta', 'Tarjeta', true)
  ON CONFLICT (sede_id, code)
  DO UPDATE SET name = EXCLUDED.name, is_active = true;

  -- ----------------------- caja lista (base configurada; turnos por UI) ---
  -- Los 2 turnos/día de §11 (casos 400/200 y 300/150) se crean por UI contra
  -- el turno abierto; el seed NO crea cash_shifts.
  INSERT INTO public.cash_registers (sede_id, name, base_configurada, is_open)
  VALUES (v_sede, 'Caja única', 300000, false)
  ON CONFLICT (sede_id, name)
  DO UPDATE SET base_configurada = EXCLUDED.base_configurada, updated_at = now();
END
$$;
