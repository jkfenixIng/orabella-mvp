-- 055_payroll_payments_cap_lock.sql — CL-16: el tope de pagos de nómina
-- (`trg_payroll_payments_cap`, 007) deja de ser una barrera sólo nominal: pasa
-- a BLOQUEAR la fila del PADRE, igual que sus dos hermanos.
--
-- MOTIVO DEL ARCHIVO (el hueco, medido)
--
-- `check_payroll_payments_cap` (007_payroll.sql, la función del trigger)
-- rechazaba cuando el acumulado del ítem superaba su neto:
--
--     SELECT coalesce(sum(amount), 0) INTO v_paid
--     FROM public.payroll_payments
--     WHERE payroll_item_id = NEW.payroll_item_id;
--
-- pero NO bloqueaba la fila padre. Dos INSERT concurrentes del MISMO ítem —dos
-- administradores, dos pestañas, dos requests que llegan juntos— toman la foto
-- de la SUMA antes de que la otra transacción confirme, no ven sus filas y los
-- dos entran: el ítem queda pagado DOS veces. El acumulado que el tope compara
-- no es el acumulado real, y por eso la barrera no era barrera.
--
-- La marca de idempotencia de la 042 protege el REINTENTO (el mismo envío, la
-- misma marca), no la CONCURRENCIA: dos pagos con marcas DISTINTAS son dos
-- operaciones legítimas y distintas, y nada las serializa. Con
-- `2 × entrante <= saldo` el tope tampoco salta: no ve la fila que todavía no
-- existe. El resultado es el doble pago, silencioso y alcanzable por dos
-- requests simultáneos.
--
-- SUS DOS HERMANOS YA HACEN LO QUE A ÉSTE LE FALTA, y el comentario de la 034
-- dice por qué: "sin el lock, dos INSERT concurrentes leerían la misma suma y
-- los dos entrarían: el lock ES la barrera".
--   * `check_invoice_payments_cap` (031) bloquea la fila de `invoices` (el
--     padre de `invoice_payments`, la que tiene el tope).
--   * `check_commission_payouts_cap` (034) bloquea también la fila de
--     `invoices` (el padre, la que tiene el ganado).
-- Acá el padre es OTRA tabla: `payroll_items`, la fila cuyo `net_pay` ES el
-- tope.
--
-- EL LOCK: QUÉ FILA Y POR QUÉ
--
-- Se bloquea la fila de `public.payroll_items` del ítem que se está pagando
-- (`WHERE id = NEW.payroll_item_id FOR UPDATE`), no la del pago que entra: la
-- fila del pago todavía no existe —estamos en un `BEFORE INSERT`— y la
-- serialización tiene que ser por REGISTRO, no por fila nueva. El ítem es el
-- registro del que cuelga el acumulado y el dueño del neto, y es el MISMO
-- `payroll_item_id` para todas las porciones de un pago (que entran en UNA
-- sentencia multi-fila).
--
-- CÓMO CIERRA LA CARRERA (por qué el lock y no otra cosa)
--
-- Cuando la segunda transacción llega al trigger, `FOR UPDATE` la deja
-- esperando a que la primera termine. Al despertar, su sentencia siguiente —el
-- SUM— toma una foto NUEVA (READ COMMITTED toma una foto por sentencia) que ya
-- incluye la fila que la otra transacción confirmó. La comparación se hace
-- contra el acumulado REAL, y si el total excede el neto, rechaza. El lock no
-- calcula nada: lo único que hace es ORDENAR la lectura de la suma DESPUÉS del
-- commit rival.
--
-- ORDEN DE LOS LOCKS (y por qué no puede haber ciclo)
--
--   1. Se bloquea el PADRE (`payroll_items`) PRIMERO.
--   2. Recién después se lee el acumulado del hijo (`payroll_payments`).
--   3. Recién después la sentencia inserta la fila.
-- Padre antes que hijo, y UNA SOLA fila padre por sentencia (todas las
-- porciones de un pago comparten `payroll_item_id`), así que no hay dos filas
-- de la misma tabla tomadas en órdenes distintos —que es lo que la 048 resuelve
-- con su `ORDER BY … FOR UPDATE` cuando bloquea varios vales de una vez—.
--
-- Entre los TRES topes no hay ciclo: éste bloquea `payroll_items`; los de 031 y
-- 034 bloquean `invoices`. Son dos dominios de fila DISJUNTOS, y ninguna
-- transacción toma los dos:
--   * `payPayrollItem` (src/features/payroll/service.ts) es el ÚNICO camino que
--     escribe `payroll_payments`, y no toca `invoices`;
--   * los únicos escritores de `invoice_payments` (el cobro dividido de
--     billing/service.ts y el espejo de caja de cash/service.ts) no tocan
--     `payroll_payments`.
-- Sin una transacción que tenga un lock de cada dominio, no hay ciclo posible
-- entre los tres topes. También queda fuera de los locks de la 048
-- (`payroll_periods` + `voucher_requests`): `payPayrollItem` lee el período sin
-- `FOR UPDATE` y no toca vales, así que no espera por ninguno de esos dos.
--
-- QUÉ CIERRA Y QUÉ NO (la ventana residual, declarada)
--
-- CIERRA: la carrera entre dos INSERT concurrentes del MISMO ítem en
-- transacciones distintas. Eso es el doble pago del hueco, y deja de ocurrir.
--
-- NO cierra tres cosas, y las tres ya eran así antes de este archivo:
--   * Las filas HERMANAS de una misma sentencia multi-fila no se ven entre sí
--     (mismo snapshot): si un INSERT crudo —sin pasar por el servicio— metiera
--     N porciones cuya suma ya excede el neto, la primera pasaría y la segunda
--     también. El lock no lo cambia (es el mismo `payroll_item_id`, y una
--     transacción no se bloquea a sí misma). El servicio no cae ahí: suma las
--     porciones ANTES de insertar y valida la suma exacta (`assertNoOverpay`),
--     y es su único escritor.
--   * La lectura de `alreadyPaid` que el servicio hace ANTES de insertar no
--     queda cubierta por el lock (el lock vive dentro del trigger). En una
--     carrera, el `paid`/`remaining` que el servicio DEVUELVE puede quedar corto
--     respecto del acumulado real si la otra transacción confirmó justo en esa
--     ventana —aunque la plata NO se paga de más: la fila se rechaza o se
--     inserta contra el acumulado real de la base—. Es una respuesta
--     desactualizada, no un asiento incorrecto.
--   * El tope sigue siendo `BEFORE INSERT`: no valida UPDATE ni DELETE de
--     `payroll_payments` (ninguno existe hoy en el modelo). Este archivo no
--     cambia eso.
--
-- DECISIÓN DECLARADA: se usa `FOR UPDATE` (el mismo idioma que 031/034), no
-- `FOR NO KEY UPDATE`. El segundo también serializaría a los dos triggers y no
-- chocaría con el `FOR KEY SHARE` que la FK de `payroll_payments` ya toma sobre
-- el ítem; es más barato, pero introduce una diferencia con los hermanos sin
-- que el hallazgo la pida. Se elige la simetría y se deja dicho.
--
-- POR QUÉ ALCANZA UN `CREATE OR REPLACE` (el trigger no cambia)
--
-- El trigger `trg_payroll_payments_cap` apunta a la función por su OID, no por
-- el texto: `CREATE OR REPLACE` con la MISMA firma conserva el OID de la
-- función, así que el trigger sigue llamando exactamente a esta definición
-- nueva. No hay que recrear el trigger, ni dropearlo, ni dropear la función (un
-- `DROP FUNCTION` con el trigger dependiendo fallaría sin CASCADE, y con
-- CASCADE se llevaría el trigger). Este archivo reescribe SÓLO el cuerpo: el
-- nombre, el `RETURNS trigger`, el `LANGUAGE plpgsql` y todo lo que no es el
-- lock quedan idénticos a la 007.
--
-- IDEMPOTENTE Y SIN RIESGO SOBRE DATOS: `CREATE OR REPLACE FUNCTION` y
-- `COMMENT ON FUNCTION` pueden correrse las veces que haga falta (no fallan si
-- ya están) y no tocan ninguna fila: no borran, no reescriben y no backfillean
-- nada. Lo único que cambia es el cuerpo de la función. El runner de Supabase
-- aplica el archivo en una sola transacción: o entra todo, o no entra nada.
--
-- ACOPLAMIENTO DE DESPLIEGUE: la 055 es SÓLO de base. El servicio YA traduce el
-- P0001 de este tope a `OVERPAID` (422) desde la 007/042
-- (`payroll/service.ts`), así que NO hace falta ningún cambio de código para
-- aplicarla y aplicarla no cambia ninguna respuesta que hoy sea correcta. Con la
-- 055 aplicada el hueco queda cerrado; sin aplicarla no hay regresión —el
-- comportamiento es el de hoy—, sólo queda el doble pago. La 055 es
-- independiente del despliegue del código, pero es OBLIGATORIA para cerrar el
-- hueco: no hay arreglo del lado de la aplicación que la reemplace (la ventana
-- está entre el último `SELECT` del servicio y el INSERT, y sólo la base puede
-- serializar esa ventana).
--
-- COSTO DE NUMERACIÓN DE ESTE ARCHIVO: usa el número 055, asignado a esta
-- unidad (052–054 están tomados; 056/057 pertenecen a otras unidades en vuelo).
-- No se reutiliza ningún número ni se renombra ningún archivo anterior. No hay
-- serie ni consecutivo que quemar: `payroll_items.id` y `payroll_payments.id`
-- son `uuid` con `DEFAULT gen_random_uuid()` (007), y una sentencia abortada no
-- deja fila ni hueco. ACÁ NO SE QUEMA NINGÚN NÚMERO.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La función, reescrita SÓLO para agregar el lock del padre
-- ===================================================================== ---

-- Idéntica a la 007 salvo el `FOR UPDATE` y el comentario que lo explica. La
-- aritmética, la tolerancia de centavo (0,009) y el `RAISE EXCEPTION` plano
-- —SQLSTATE P0001, el que el servicio traduce a OVERPAID— NO cambian.
CREATE OR REPLACE FUNCTION public.check_payroll_payments_cap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_net numeric(12, 2);
  v_paid numeric(12, 2);
BEGIN
  -- Lock de la fila PADRE (el ítem, dueño del neto): serializa dos pagos
  -- concurrentes del mismo ítem. Es el mismo idioma que 031 y 034, donde la
  -- fila bloqueada es también la que tiene el tope (allá `invoices`). Va ANTES
  -- del SUM a propósito: es lo que hace que el SUM corra después del commit
  -- rival y vea su fila.
  SELECT net_pay INTO v_net
  FROM public.payroll_items
  WHERE id = NEW.payroll_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ítem de nómina inexistente (%)', NEW.payroll_item_id;
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_paid
  FROM public.payroll_payments
  WHERE payroll_item_id = NEW.payroll_item_id;

  IF v_paid + NEW.amount - v_net > 0.009 THEN
    RAISE EXCEPTION 'El pago supera el neto del ítem (neto %, pagado %, nuevo %)', v_net, v_paid, NEW.amount;
  END IF;

  RETURN NEW;
END;
$$;

-- ===================================================================== ---
-- 2. Documentación de la función desde `\df`
-- ===================================================================== ---

COMMENT ON FUNCTION public.check_payroll_payments_cap() IS
'CL-16: la suma de payroll_payments por ítem nunca excede payroll_items.net_pay (tolerancia de centavo 0,009). A diferencia de la 007, BLOQUEA la fila del padre (`payroll_items`) con FOR UPDATE antes de leer el acumulado: sin el lock, dos INSERT concurrentes del mismo ítem leían la misma suma, no veían la fila rival y los dos entraban —el ítem pagado dos veces—. El lock ordena la lectura del acumulado después del commit rival, y con READ COMMITTED el SUM ve la fila ya confirmada. RAISE EXCEPTION plano = SQLSTATE P0001, el que payroll/service.ts traduce a OVERPAID (422). No crea, reemplaza ni borra filas: sólo reescribe el cuerpo de la función, así que el trigger trg_payroll_payments_cap (007) conserva su vínculo por OID.';

-- ===================================================================== ---
-- 3. El trigger NO se toca (por qué no hace falta)
-- ===================================================================== ---

-- `CREATE OR REPLACE FUNCTION` conserva el OID de la función cuando la firma no
-- cambia, así que `trg_payroll_payments_cap` (007) sigue apuntando a esta
-- definición nueva y conserva su `BEFORE INSERT ON public.payroll_payments FOR
-- EACH ROW`. No se emite ningún `CREATE TRIGGER` ni `DROP TRIGGER`: recrear el
-- trigger con el mismo nombre sólo agregaría una ventana sin trigger entre el
-- DROP y el CREATE, y el archivo sería menos idempotente por nada.
