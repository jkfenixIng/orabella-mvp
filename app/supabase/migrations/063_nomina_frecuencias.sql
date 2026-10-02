-- 063_nomina_frecuencias.sql — F1: la CADENCIA de pago por empleado y por
-- período, y la guarda de solape acotada por sede Y cadencia.
--
-- MOTIVO DEL ARCHIVO
--
-- La nómina no conoce la cadencia de pago. El fijo se prorratea por los DÍAS
-- calendario del período (`prorateFixedSalary`, src/features/payroll/schemas.ts)
-- y no existe en ningún lado la idea de "semanal paga 1/4 del mensual, quincenal
-- la mitad, mensual completo". Sin cadencia no se puede deducir la fracción del
-- fijo ni decidir a quién le toca en un período, y la única guarda de días
-- (`ex_payroll_periods_no_overlap`, 035) prohíbe CUALQUIER solape dentro de una
-- sede, de modo que un ciclo semanal y uno mensual —que se superponen A
-- PROPÓSITO— no pueden convivir.
--
-- LA DECISIÓN DEL DUEÑO (ya tomada; este archivo la implementa, no la discute)
--
--   * Semanal paga mensual / 4, quincenal mensual / 2, mensual el mes completo,
--     sobre un mes comercial de 30 días (el mes son 4 semanas). Consecuencia
--     aceptada y visible: 1/4 por semana paga ≈ 13 sueldos al año (52,14
--     semanas), no 12.
--   * La cadencia se acuerda POR EMPLEADO (alta y edición) y el PERÍODO tiene
--     la suya; la sede no impone una cadencia única.
--   * Un día se sigue nominando UNA sola vez DENTRO DEL MISMO CICLO; dos ciclos
--     distintos de la misma sede sí pueden compartir días.
--
-- QUÉ HACE ESTE ARCHIVO (y qué NO)
--
--   1. `employees.pay_frequency` (text NULL, semanal | quincenal | mensual).
--   2. `payroll_periods.frequency` (text NULL, los mismos tres valores).
--   3. Reemplaza `ex_payroll_periods_no_overlap` (035) por la misma exclusión
--      acotada además por la cadencia, de modo que un período semanal y uno
--      mensual de la misma sede puedan superponerse y dos períodos del MISMO
--      ciclo no puedan compartir un día.
--
-- NO calcula nada (la fracción del fijo y la regla del mixto son de la unidad
-- de CÁLCULO), NO pregunta ni muestra la cadencia (unidad de EMPLEADOS), NO
-- elige la cadencia del período en la pantalla (unidad de PERÍODOS) y NO toca
-- la identidad del CHECK de `payroll_items` (007): acá no hay aritmética ni
-- columnas de dinero. Tampoco hay migración de datos: no se escribe ni una fila
-- y los períodos ya cerrados no se recalculan.
--
-- NULL ES "SIN CADENCIA DEFINIDA" Y CONSERVA EL COMPORTAMIENTO DE HOY
--
-- Las dos columnas nacen NULL y NULL no es un valor más: es la AUSENCIA de
-- cadencia. Un empleado sin `pay_frequency` sigue cobrando el fijo prorrateado
-- por los días calendario del período (`prorateFixedSalary`, exactamente como
-- hoy) y un período sin `frequency` sigue siendo el período de hoy. Es
-- DELIBERADO: ningún empleado, período ni prueba existente cambia de
-- comportamiento por esta migración, y las unidades de cálculo y de UI pueden
-- entrar después sin que el esquema las fuerce. El CHECK admite NULL a
-- propósito y lo escribe explícito (`IS NULL OR ...`) en vez de confiar en que
-- el NULL pase el `IN`, para que la intención quede a la vista.
--
-- POR QUÉ LA GUARDA USA `coalesce(frequency, '')` Y NO LA COLUMNA PELADA
--
-- En una restricción de exclusión, un NULL NO es igual a otro NULL (para el
-- operador `=` del índice, NULL es DISTINTO de NULL): con la columna pelada,
-- todos los períodos heredados (todos NULL) quedarían mutuamente distintos y la
-- guarda dejaría de protegerlos EN SILENCIO —dos períodos del mismo ciclo y la
-- misma sede podrían compartir días—. `coalesce(frequency, '')` convierte todo
-- NULL en la cadena vacía, de modo que los períodos SIN cadencia quedan iguales
-- entre sí y siguen mutuamente excluyentes, tal como hoy. El elemento de
-- cadencia separa ciclos distintos y el rango sigue diciendo "estos días". El
-- operador `=` de `text` dentro del índice gist lo aporta `btree_gist` (la
-- extensión que 035 ya instaló): sin ella gist no sabría comparar texto. Este
-- archivo no vuelve a crear la extensión porque la serie la dejó puesta en 035.
--
-- LA GUARDA SE PUEDE CREAR SOBRE LOS DATOS QUE YA HAY
--
-- La restricción nueva es IGUAL o MÁS PERMISIVA que la vieja para cada fila
-- existente: como la columna acaba de nacer, TODA fila existente tiene
-- `frequency` NULL, y con NULL la cadencia coalescida es '' para todas, así que
-- la exclusión nueva coincide exactamente con la vieja (sede + rango). Ninguna
-- fila existente puede violarla y el ALTER no falla con 23P01. Lo mismo aplica
-- a las dos columnas: `ADD COLUMN` nullable sin DEFAULT es sólo catálogo (no
-- reescribe la tabla) y el CHECK pasa porque NULL lo satisface. Ninguna de las
-- sentencias de este archivo borra, reescribe ni migra una sola fila.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF
-- EXISTS` seguido de `ADD CONSTRAINT` (el patrón de 038) y `COMMENT ON` dejan el
-- esquema idéntico en cada corrida: re-ejecutar no duplica la restricción ni
-- choca con "already exists". El runner de Supabase aplica el archivo en una
-- transacción: o entra todo, o no entra nada.
--
-- COSTO DE NUMERACIÓN: 063 es el siguiente libre (la serie llega a 062); este
-- archivo NO renumera ni toca ningún archivo anterior.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La cadencia del EMPLEADO (`pay_frequency`)
-- ===================================================================== ---

-- La cadencia acordada con el empleado. NULL = sin cadencia definida, que es el
-- estado de TODOS los empleados hoy y el que conserva el fijo prorrateado por
-- días calendario. Un valor sólo cambia lo que la unidad de CÁLCULO haga con la
-- fracción del fijo; esta columna es el ALMACENAMIENTO de esa decisión.
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS pay_frequency text NULL;

-- El CHECK nombrado y re-creado: `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`
-- deja una sola definición vigente en cada corrida (038). NULL se admite de
-- forma explícita (es el estado heredado) y la lista de valores es CERRADA: un
-- cuarto valor no es una cadencia que la nómina sepa liquidar.
ALTER TABLE public.employees
  DROP CONSTRAINT IF EXISTS chk_employees_pay_frequency;

ALTER TABLE public.employees
  ADD CONSTRAINT chk_employees_pay_frequency
  CHECK (pay_frequency IS NULL OR pay_frequency IN ('semanal', 'quincenal', 'mensual'));

COMMENT ON COLUMN public.employees.pay_frequency IS
  'F1: cadencia de pago acordada con el empleado: semanal (mensual / 4), quincenal (mensual / 2) o mensual (mes completo), sobre un mes comercial de 30 días. NULL = sin cadencia definida: el fijo se sigue prorrateando por los días calendario del período (prorateFixedSalary), que es el comportamiento de hoy. La fracción del fijo se aplica en la unidad de CÁLCULO; esta columna sólo la almacena.';

-- ===================================================================== ---
-- 2. La cadencia del PERÍODO (`frequency`)
-- ===================================================================== ---

-- La cadencia del período. NULL = sin cadencia definida: el período se comporta
-- como hoy (días calendario y la guarda histórica). Un valor declara el ciclo
-- del rango y es lo que la guarda de abajo usa para separar ciclos.
ALTER TABLE public.payroll_periods
  ADD COLUMN IF NOT EXISTS frequency text NULL;

ALTER TABLE public.payroll_periods
  DROP CONSTRAINT IF EXISTS chk_payroll_periods_frequency;

ALTER TABLE public.payroll_periods
  ADD CONSTRAINT chk_payroll_periods_frequency
  CHECK (frequency IS NULL OR frequency IN ('semanal', 'quincenal', 'mensual'));

COMMENT ON COLUMN public.payroll_periods.frequency IS
  'F1: cadencia del período: semanal, quincenal o mensual. NULL = sin cadencia definida: el período se comporta como hoy (el fijo se prorratea por días calendario y la guarda lo trata como cadencia vacía). Un valor acota la guarda de solape: dos períodos de la misma sede sólo comparten días si su cadencia difiere.';

-- ===================================================================== ---
-- 3. La guarda de solape, acotada por sede Y cadencia
-- ===================================================================== ---

-- Reemplazo EN EL MISMO NOMBRE (035): `ex_payroll_periods_no_overlap` pasa de
-- `(sede_id, rango)` a `(sede_id, cadencia, rango)`. Se conserva el nombre para
-- que la guarda siga teniendo una sola identidad (el servicio mapea su 23P01 a
-- PERIOD_OVERLAP en payroll/service.ts y el diagnóstico la busca por nombre).
-- El `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` es el mismo patrón
-- idempotente de 038 y no deja dos restricciones si el archivo se re-ejecuta.
--
-- El elemento `coalesce(frequency, '')` es lo que mantiene viva la protección
-- heredada: sin él, los NULL de los períodos ya existentes serían todos
-- distintos entre sí y la guarda los soltaría sin avisar. Con él, los períodos
-- sin cadencia quedan iguales a '' y siguen sin poder compartir un día.
ALTER TABLE public.payroll_periods
  DROP CONSTRAINT IF EXISTS ex_payroll_periods_no_overlap;

ALTER TABLE public.payroll_periods
  ADD CONSTRAINT ex_payroll_periods_no_overlap
  EXCLUDE USING gist (
    sede_id WITH =,
    coalesce(frequency, '') WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );

COMMENT ON CONSTRAINT ex_payroll_periods_no_overlap ON public.payroll_periods IS
  'F1: un día se nomina una sola vez DENTRO DEL MISMO CICLO. Dos períodos de la misma sede y la misma cadencia no pueden compartir días (el rango sigue siendo inclusivo). La cadencia se compara con coalesce(frequency, '''') para que los períodos sin cadencia (NULL) sigan siendo mutuamente excluyentes: un NULL pelado sería distinto de otro NULL y la guarda dejaría de protegerlos. Ciclos distintos (semanal y mensual) sí pueden superponerse, que es el objetivo del dueño.';

-- ===================================================================== ---
-- 4. Nota para quien aplica (verificación; no hay SQL que cambie datos)
-- ===================================================================== ---
--
-- Después de aplicar el archivo, compruebe en PRUEBAS:
--   * `employees.pay_frequency`: la columna existe, es `text` nullable, y su
--     CHECK `chk_employees_pay_frequency` admite NULL y los tres valores. Los
--     empleados existentes quedan en NULL y su liquidación no cambia.
--   * `payroll_periods.frequency`: la misma forma y su CHECK
--     `chk_payroll_periods_frequency`. Los períodos existentes quedan en NULL.
--   * `ex_payroll_periods_no_overlap`: en `pg_constraint` hay UNA sola fila con
--     ese nombre para `payroll_periods`, y `pg_get_constraintdef` muestra los
--     tres elementos (`sede_id`, `coalesce(frequency, '')` y el
--     `daterange(start_date, end_date, '[]')`).
--   * Prueba funcional con filas de prueba (no con las reales): dos períodos de
--     la misma sede con `frequency` distinta y días en común deben insertar sin
--     error; dos con la MISMA cadencia —o los dos NULL— y un día en común deben
--     fallar con 23P01.
--   * Si vuelve a correr el archivo, el esquema queda igual: una sola
--     restricción y una sola definición de cada CHECK.
--
-- OJO: no vuelva a correr 035 después de crear períodos semanales y mensuales
-- que se superpongan. El pre-vuelo de 035 aborta ante CUALQUIER solape de sede y
-- su `IF NOT EXISTS` no protegería de eso: la definición vigente de la guarda es
-- la de este archivo.
