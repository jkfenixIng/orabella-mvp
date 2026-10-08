-- 073_sede_id_nullable.sql — `sede_id` deja de ser OBLIGATORIA en las
-- dieciocho tablas que la exigían.
--
-- MOTIVO DEL ARCHIVO
--
-- El proyecto es físicamente de una sola sede (decisión del dueño, 2026-10-01).
-- Las unidades anteriores ya retiraron la estructura multi sede: la tabla
-- `sedes` es la fila del sistema (070), las funciones atómicas dejaron de
-- recibir el parámetro de sede (071) y los ajustes por sede se mudaron a una
-- tabla de la instalación (072). Lo que quedó en pie es la COLUMNA: veinte y una
-- tablas la tienen, y en dieciocho de ellas sigue declarada `NOT NULL`.
--
-- Esa declaración es la última traba del borrado. El código no puede dejar de
-- escribir `sede_id` mientras la base la exija: una fila que nazca sin la sede
-- es rechazada por la propia base antes de que el servicio pueda hacer nada. El
-- orden obligatorio es, entonces, el inverso del que parece intuitivo —primero
-- se RELAJA la exigencia, después se deja de escribir la columna, y sólo al
-- final se borra— porque al revés no hay ningún punto en el que el esquema y el
-- código puedan estar de acuerdo.
--
-- POR QUÉ ESTA UNIDAD NO ES LA QUE BORRA
--
-- Borrar la columna es el paso irreversible de la serie. Este archivo hace
-- exactamente lo que esa serie necesita ANTES de él y nada más: quitar una
-- restricción que ya no describe la realidad de la instalación. Un paso
-- aditivo, reversible y que no obliga al código a cambiar ni un solo carácter.
--
--   * Unit que borra `sede_id` (M3c): quita la columna de cada tabla, con sus
--     claves foráneas, sus índices, sus restricciones de unicidad y sus
--     políticas. Sólo puede correr cuando NADIE la escribe ni la lee.
--   * Unidad que deja de escribir: saca `sede_id` de las listas de columnas de
--     las listas de columnas de las escrituras del servidor y de los cuerpos de
--     las funciones atómicas. El código deja de mandarla cuando la base ya no
--     la exige —este archivo—.
--
-- La frontera de sede que queda entre ambas es `resolveSede`
-- (`src/shared/lib/sede.ts`): mientras la columna exista, esa es la barrera que
-- rechaza una fila cargada de otra sede. No se toca acá.
--
-- LAS DIECIOCHO TABLAS, Y DE QUÉ MIGRACIÓN CADA UNA SALE
--
-- La lista se leyó de los archivos, no de un inventario: en cada migración se
-- buscó la declaración de la columna y se comprobó su nulabilidad.
--
--   * `users` — declarada `sede_id uuid NULL` en 002_auth.sql y convertida en
--     obligatoria por 003_admin.sql (`ALTER COLUMN sede_id SET NOT NULL`), que
--     además le puso su clave foránea con nombre propio (`fk_users_sede`).
--   * `employees`, `services`, `tax_configs`, `payment_methods` — 003_admin.sql.
--   * `products`, `inventory_movements` — 004_inventory.sql.
--   * `invoices` — 005_billing.sql.
--   * `cash_registers`, `cash_shifts`, `payments` — 006_cash.sql.
--   * `payroll_periods`, `voucher_requests` — 007_payroll.sql.
--   * `cash_denominations` — 010_cash_denominations.sql.
--   * `commission_rules`, `commission_payouts` — 016_commissions.sql.
--   * `payroll_extras` — 036_payroll_extra_payment.sql.
--   * `payroll_discount_carries` — 061_payroll_voucher_debt.sql.
--
-- LAS DOS QUE NO ENTRAN, Y POR QUÉ
--
-- Veinte y una tablas tienen la columna, pero sólo dieciocho se relajan:
--
--   * `invoice_sequences` (005_billing.sql) y `voucher_settings`
--     (007_payroll.sql) declaran `sede_id` como CLAVE PRIMARIA. En una clave
--     primaria la nulabilidad es implícita y no se puede quitar sin quitar la
--     clave, que es justamente lo que esta unidad prohíbe. Además 072 ya decidió
--     su destino: los dos ajustes se mudaron a `system_settings` y las dos
--     tablas las borra la unidad M3c, que sí puede dejar una fila sin sede.
--   * `audit_logs` (008_hardening.sql) declara `sede_id uuid NULL` desde que se
--     creó, a propósito: el intento de acceso con un documento inexistente no
--     tiene sede que registrar. Ya es nulable y no hay nada que relajar.
--
-- QUÉ HACE ESTE ARCHIVO: SÓLO ESO
--
-- Dieciocho sentencias `ALTER TABLE … ALTER COLUMN sede_id DROP NOT NULL`. No
-- hay ninguna otra cosa en el archivo: ni una fila escrita, ni una fila leída,
-- ni un valor por omisión, ni una referencia a `sedes` fuera de los nombres de
-- tabla, ni una función, ni una política, ni un disparador.
--
-- LO QUE NO TOCA (y por qué importa que siga en pie)
--
--   * Las CLAVES FORÁNEAS a `sedes` siguen existiendo y siguen funcionando: el
--     dueño todavía tiene filas que referencian esa tabla, y una fila sin sede
--     tiene que quedar prohibida por la clave, no aceptada en silencio. Se
--     relaja la OBLIGATORIEDAD de tener sede, no la EXISTENCIA de la sede: la
--     columna conserva su nombre, su tipo y su lugar en el esquema, y no se le
--     da ningún valor por omisión.
--   * Los ÍNDICES, incluidas las unicidades parciales por sede y por rango de
--     fechas (`uq_payroll_draft_per_range`, 007) y la restricción de exclusión
--     `ex_payroll_periods_no_overlap` (035), que compara `sede_id` con `=`.
--   * Las RESTRICCIONES DE UNICIDAD y los `CHECK` de cada tabla.
--   * Las POLÍTICAS y el estado de la seguridad por fila: este archivo no
--     escribe nada de eso.
--   * La COLUMNA: sigue existiendo, con el mismo tipo y las mismas claves.
--   * `supabase/test-bootstrap.sql`, que es un volcado independiente del
--     esquema; aplicarle este archivo encima es lo que hace el runner.
--
-- ADITIVO, REVERSIBLE E IDEMPOTENTE
--
-- Aditivo: sólo se quita una restricción; no se agrega ningún objeto nuevo.
-- Reversible: `ALTER COLUMN sede_id SET NOT NULL` la restituye (sección de
-- verificación, abajo). Como no se escribe ninguna fila, ninguna fila puede
-- quedar con la sede nula y la vuelta atrás no encuentra contradicciones.
-- Idempotente: quitar una nulabilidad que ya no está no es un error, así que
-- una segunda corrida deja el esquema igual (mismo criterio que 026, que relaja
-- dos columnas de `voucher_settings` de la misma forma).
--
-- El runner de Supabase aplica el archivo en una transacción: o entran las
-- dieciocho, o no entra ninguna.
--
-- LO QUE ESTA UNIDAD NO TOCA DEL CÓDIGO
--
-- Ninguno: ni un archivo de la aplicación, ni un test de servicio, ni un tipo.
-- El contrato de `sede_id` en TypeScript, los esquemas Zod y las listas de
-- columnas de cada consulta siguen como están; esta unidad no los habilita para
-- dejar de escribir la sede, sólo deja de impedirlo.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. Las dieciocho columnas que dejan de ser obligatorias
-- ===================================================================== ---
--
-- Una sentencia por tabla, en el orden en que cada migración creó la columna.
-- No hay guarda: todas estas tablas existen desde 002…061 y todas declaran la
-- columna, así que una corrida repetida es un no-op sobre el mismo esquema.

-- 002_auth.sql + 003_admin.sql (la obligatoriedad venía del `SET NOT NULL`).
ALTER TABLE public.users ALTER COLUMN sede_id DROP NOT NULL;

-- 003_admin.sql.
ALTER TABLE public.employees ALTER COLUMN sede_id DROP NOT NULL;
ALTER TABLE public.services ALTER COLUMN sede_id DROP NOT NULL;
ALTER TABLE public.tax_configs ALTER COLUMN sede_id DROP NOT NULL;
ALTER TABLE public.payment_methods ALTER COLUMN sede_id DROP NOT NULL;

-- 004_inventory.sql.
ALTER TABLE public.products ALTER COLUMN sede_id DROP NOT NULL;
ALTER TABLE public.inventory_movements ALTER COLUMN sede_id DROP NOT NULL;

-- 005_billing.sql.
ALTER TABLE public.invoices ALTER COLUMN sede_id DROP NOT NULL;

-- 006_cash.sql.
ALTER TABLE public.cash_registers ALTER COLUMN sede_id DROP NOT NULL;
ALTER TABLE public.cash_shifts ALTER COLUMN sede_id DROP NOT NULL;
ALTER TABLE public.payments ALTER COLUMN sede_id DROP NOT NULL;

-- 007_payroll.sql.
ALTER TABLE public.payroll_periods ALTER COLUMN sede_id DROP NOT NULL;
ALTER TABLE public.voucher_requests ALTER COLUMN sede_id DROP NOT NULL;

-- 010_cash_denominations.sql.
ALTER TABLE public.cash_denominations ALTER COLUMN sede_id DROP NOT NULL;

-- 016_commissions.sql.
ALTER TABLE public.commission_rules ALTER COLUMN sede_id DROP NOT NULL;
ALTER TABLE public.commission_payouts ALTER COLUMN sede_id DROP NOT NULL;

-- 036_payroll_extra_payment.sql.
ALTER TABLE public.payroll_extras ALTER COLUMN sede_id DROP NOT NULL;

-- 061_payroll_voucher_debt.sql.
ALTER TABLE public.payroll_discount_carries ALTER COLUMN sede_id DROP NOT NULL;

-- ===================================================================== ---
-- 2. Cómo verifica el dueño (sólo lectura)
-- ===================================================================== ---
--
-- Las consultas siguientes NO cambian nada: se copian y se ejecutan tal cual en
-- el editor de la consola.
--
-- 2.1 La nulabilidad por tabla. Las dieciocho deben decir `YES`; las tres
--     que quedan fuera, también, y por otra razón: `audit_logs` ya era
--     nulable, `invoice_sequences` y `voucher_settings` son clave primaria (una
--     clave primaria es `NO` y no se puede relajar sin quitarla).
--
--   SELECT table_name, is_nullable, data_type
--     FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND column_name = 'sede_id'
--    ORDER BY table_name;

-- 2.2 Que las claves foráneas a `sedes` siguen ahí, con su nombre: son las que
--     impiden que una fila quede apuntando a una sede que no existe.
--
--   SELECT c.conname AS clave, cl.relname AS tabla, a.attname AS columna
--     FROM pg_constraint c
--     JOIN pg_class cl ON cl.oid = c.conrelid
--     JOIN pg_namespace n ON n.oid = cl.relnamespace
--     JOIN unnest(c.conkey) AS k(attnum) ON true
--     JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = k.attnum
--    WHERE c.contype = 'f'
--      AND n.nspname = 'public'
--      AND a.attname = 'sede_id'
--    ORDER BY cl.relname, c.conname;

-- 2.3 Que las restricciones y los índices que comparan la sede siguen
--     declarados (mismo motivo que 2.2: relajar la obligatoriedad no puede tocar
-- nada más).
--
--   SELECT conrelid::regclass AS tabla, conname, contype
--     FROM pg_constraint
--    WHERE conrelid IN ('public.payroll_periods'::regclass)
--    ORDER BY conname;

--   SELECT indexname, indexdef
--     FROM pg_indexes
--    WHERE schemaname = 'public'
--      AND indexdef LIKE '%sede_id%'
--    ORDER BY indexname;

-- ===================================================================== ---
-- 3. Cómo se revierte
-- ===================================================================== ---
--
-- Es la operación inversa, sentencia por sentencia. La anoto completa para que
-- la vuelta atrás no dependa de que nadie recuerde la lista.
--
--   ALTER TABLE public.users ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.employees ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.services ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.tax_configs ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.payment_methods ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.products ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.inventory_movements ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.invoices ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.cash_registers ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.cash_shifts ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.payments ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.payroll_periods ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.voucher_requests ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.cash_denominations ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.commission_rules ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.commission_payouts ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.payroll_extras ALTER COLUMN sede_id SET NOT NULL;
--   ALTER TABLE public.payroll_discount_carries ALTER COLUMN sede_id SET NOT NULL;
--
-- PRECONDICIÓN DE LA VUELTA ATRÁS (sólo lectura, una consulta por tabla):
-- tiene que dar 0 en las dieciocho. Si alguna tabla llegara a tener una fila sin
-- sede, la obligación no se puede reponer sin decidir antes qué hacer con esa
-- fila, y esa decisión es del dueño, no de esta migración.
--
--   SELECT count(*) FROM public.users WHERE sede_id IS NULL;   -- 0
--
-- La consulta se repite cambiando el nombre de la tabla. Al salir de este
-- archivo el esquema es exactamente el que había antes, salvo por la
-- nulabilidad de la columna.
