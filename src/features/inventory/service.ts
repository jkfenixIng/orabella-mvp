import {
  applyMovementStock,
  filterLowStock,
  manualMovementSchema,
  movementSchema,
  normalizeSku,
  planStockDeduction,
  productSchema,
  sortKardexAscending,
  type DeductionLine,
  type MovementInput,
  type PlannedDeduction,
  type ProductInput,
} from "./schemas";
import type { RoleCode } from "@/src/features/auth/schemas";
import { getSessionUser } from "@/src/features/auth/service";
import { requireSedeRole } from "@/src/shared/lib/sede";
import { requireSession } from "@/src/features/admin/service";
import { DbQueryError } from "@/src/shared/db/errors";
import { COP_WHOLE_PESO_MESSAGE, isCopWholePesoError } from "@/src/shared/money/cop";
import {
  inventoryRepo,
  type InventoryRepo,
  type MovementRow,
  type ProductRow,
} from "./repos/inventory";

export type { MovementRow, ProductRow } from "./repos/inventory";

export class InventoryError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "InventoryError";
    this.code = code;
    this.status = status;
  }
}

/** Repositorio del motor configurado (supabase por defecto), cargado bajo demanda. */
async function inventoryDb(): Promise<InventoryRepo> {
  return inventoryRepo();
}

/**
 * Límite de lectura para listados (navegación instantánea): 50 filas por
 * defecto; kardex y alertas (excepcionales) acotados a 200. Nunca sin límite.
 */
function clampLimit(limit: number | undefined, def = 50, max = 500): number {
  if (limit === undefined) return def;
  if (!Number.isFinite(limit)) return def;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

function validationMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Datos inválidos.";
}

/** Roles que pueden escribir inventario (upsert + movimientos). */
const WRITER_ROLES: RoleCode[] = ["admin", "caja"];

/** Solo admin: editar productos y movimientos que no sean entradas. */
export async function requireInventoryAdmin(
  token: string | null | undefined,
): Promise<{ userId: string; sedeId: string; roles: RoleCode[] }> {
  const session = await requireInventoryWriter(token);
  requireSedeRole(session.roles, ["admin"]);
  return session;
}

/**
 * §10 Inventario: escritura sólo admin/caja; lectura cualquier rol
 * autenticado (las rutas y actions aplican este gate).
 *
 * La SEDE no es una frontera del inventario: es un dato de la sesión que la
 * guarda devuelve y que ya no acota ninguna lectura ni ninguna escritura de este
 * módulo.
 */
export async function requireInventoryWriter(
  token: string | null | undefined,
): Promise<{ userId: string; sedeId: string; roles: RoleCode[] }> {
  const session = await getSessionUser(token);
  if (!session) {
    throw new InventoryError("UNAUTHENTICATED", "Se requiere autenticación.", 401);
  }
  requireSedeRole(session.roles, WRITER_ROLES);
  if (!session.user.sede_id) {
    throw new InventoryError("NO_SEDE", "El usuario no tiene sede asignada.", 403);
  }
  return { userId: session.user.id, sedeId: session.user.sede_id, roles: session.roles };
}

// ------------------------------------------------------------------ productos ---
/** Any database failure of this module is the same opaque INTERNAL error. */
function internal(): InventoryError {
  return new InventoryError("INTERNAL", "Error interno.", 500);
}

/** Runs a repository read; a database failure becomes INTERNAL 500. */
async function read<T>(query: (db: InventoryRepo) => Promise<T>): Promise<T> {
  const db = await inventoryDb();
  try {
    return await query(db);
  } catch {
    throw internal();
  }
}

/** INV-05 + lectura: lista productos activos e inactivos (máx. 50 por defecto). */
export async function listProducts(limit?: number): Promise<ProductRow[]> {
  // Orden total name, id (fase 3b-2): los empates de nombre no se repiten entre páginas.
  return read((db) => db.listProducts(clampLimit(limit)));
}

export async function getProduct(id: string): Promise<ProductRow> {
  const product = await read((db) => db.findProduct(id));
  if (!product) throw new InventoryError("NOT_FOUND", "Producto no encontrado.", 404);
  return product;
}

/**
 * INV-01: crea o actualiza un producto (upsert por id). El SKU se
 * normaliza (trim + mayúsculas) y se valida a nivel app para devolver
 * SKU_TAKEN; el UNIQUE (sku) de la base sigue cubriendo carreras.
 * INV-03: nunca toca stock_qty (el stock inicial va vía movimiento IN).
 */
export async function upsertProduct(raw: unknown): Promise<ProductRow> {
  const parsed = productSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InventoryError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input: ProductInput = parsed.data;
  const sku = normalizeSku(input.sku);
  const db = await inventoryDb();

  const conflicts = await read(() => db.skuConflicts(sku, input.id));
  if (conflicts.length > 0) {
    throw new InventoryError("SKU_TAKEN", "El SKU ya existe.", 409);
  }

  let saved: ProductRow | null;
  try {
    saved = await db.upsertProduct({
      ...(input.id ? { id: input.id } : {}),
      sku,
      name: input.name,
      description: input.description ?? null,
      min_stock: input.min_stock,
      cost_price: input.cost_price ?? null,
      sale_price: input.sale_price ?? null,
      commission_value: input.commission_value ?? null,
      ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
    });
  } catch (error) {
    // Carrera perdida contra UNIQUE (sku): mismo error de negocio.
    if (error instanceof DbQueryError && error.error.code === "23505") {
      throw new InventoryError("SKU_TAKEN", "El SKU ya existe.", 409);
    }
    if (isCopWholePesoError(error)) throw new InventoryError("VALIDATION", COP_WHOLE_PESO_MESSAGE, 400);
    throw internal();
  }
  if (!saved) throw internal();
  return saved;
}

/**
 * INV-05: búsqueda por fragmento de nombre o SKU (máx. 50 por defecto).
 *
 * Fase 3b-2 (corrección intencional): el fragmento es TEXTO LITERAL en los dos
 * motores —comas, paréntesis, comillas, `%`, `_` y `\` nunca son sintaxis—.
 * Antes el valor iba sin comillas en el `.or()` de PostgREST, donde `,` y `)`
 * cortaban el filtro, y `*` no tenía escape (PostgREST lo vuelve `%`).
 *
 * Migración 004: la búsqueda la hace `search_products_literal` en los dos
 * motores, con el texto como parámetro tipado. `*` es literal, la respuesta ya
 * es exacta y completa: una sola lectura de una página, sin filtro posterior.
 */
export async function searchProducts(q: string, limit?: number): Promise<ProductRow[]> {
  const needle = q.trim();
  if (needle === "") return listProducts(limit);
  return read((db) => db.searchProducts(needle, clampLimit(limit)));
}

/** INV-04: productos con stock en o bajo el mínimo (alerta visible, máx. 200). */
export async function lowStockAlerts(limit?: number): Promise<ProductRow[]> {
  return filterLowStock(await read((db) => db.activeByStock(clampLimit(limit, 200))));
}

// ---------------------------------------------------------------- movimientos ---
/** El que registra el movimiento: sólo su identidad. */
export interface MovementActor {
  userId: string;
}

export interface RegisterMovementResult {
  movement: MovementRow;
  stock_qty: number;
}

/**
 * CL-6: el movimiento del PRODUCTO que YA se registró con esa marca, si existe.
 *
 * La marca es un uuid que acuña la pantalla al empezar el intento de movimiento
 * y que reutiliza en los reintentos del MISMO intento; ver `idempotencyKeySchema`
 * (billing/schemas.ts) y `manualMovementSchema` (schemas.ts). El filtro es por el
 * PRODUCTO: el registro de esta operación es el producto —es donde vive el stock,
 * es la dimensión del kardex (`idx_movements_product_created`) y es lo que el
 * servicio resuelve ANTES de este lookup—, así que el lookup nunca puede
 * devolver el movimiento de otro producto, y la misma marca en dos productos
 * distintos son DOS operaciones.
 * La clave del índice de la 045 es la MISMA (`product_id, idempotency_key`): el
 * `eq` de este lookup y la clave del índice son el mismo conjunto, así que este
 * lookup no puede devolver una fila que el índice no habría bloqueado.
 *
 * La SEDE NO entra en la clave porque no agrega identidad: el PRODUCTO es el
 * registro de la operación —es donde vive el stock y es la dimensión del kardex
 * (`idx_movements_product_created`)—, así que la marca se resuelve dentro del
 * producto que la usó. La MISMA marca para OTRO producto es OTRA operación
 * (agregar la sede a la clave, en cambio, colapsaría dos movimientos legítimos de
 * productos distintos bajo una sola marca, y devolvería el movimiento del producto
 * equivocado como si fuera la repetición del que se pidió).
 */
async function findMovementByIdempotencyKey(
  db: InventoryRepo,
  productId: string,
  idempotencyKey: string,
): Promise<MovementRow | null> {
  return read(() => db.findMovementByKey(productId, idempotencyKey));
}

/** INSUFFICIENT_STOCK is decided by the RAISE EXCEPTION message on both engines. */
function isInsufficientStock(error: unknown): boolean {
  return error instanceof DbQueryError && error.error.message.includes("INSUFFICIENT_STOCK");
}

/**
 * CL-6: frontera del movimiento MANUAL. Valida con `manualMovementSchema`, que
 * exige `idempotency_key` (la marca del INTENTO), y delega en `registerMovement`.
 *
 * Por qué existe: `registerMovement` la comparten el camino manual y el de
 * FACTURACIÓN (emisión, anulación, edición), y esos últimos no tienen un intento
 * propio del cliente. La marca se exige SOLO acá, en la puerta del camino manual
 * (la server action `registerMovementAction` y la ruta
 * `POST /api/v1/inventory/movements` llaman a ESTA función, y ninguna llama a
 * `registerMovement` directo), así que no se le inventa un intento a la
 * facturación.
 *
 * El rechazo es ruidoso y NO escribe nada: la validación corre ANTES de la
 * primera lectura y de la primera escritura (el movimiento y el stock quedan
 * intactos).
 */
export async function registerManualMovement(
  raw: unknown,
  actor: MovementActor,
): Promise<RegisterMovementResult> {
  const parsed = manualMovementSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InventoryError("VALIDATION", validationMessage(parsed.error), 400);
  }
  return registerMovement(parsed.data, actor);
}

/**
 * INV-02/INV-03/INV-04: registra un movimiento y devuelve el stock
 * resultante. IN suma, OUT resta (bloqueado si quedaría negativo),
 * ADJUST fija el nivel con motivo obligatorio.
 *
 * El stock lo aplica el trigger trg_inventory_apply_stock (único
 * escritor); aquí se pre-verifica con applyMovementStock para un error de
 * negocio claro y se traduce la excepción INSUFFICIENT_STOCK del trigger
 * (carreras concurrentes) al mismo código 409.
 *
 * CL-6 (idempotencia): si el movimiento trae la MARCA del intento
 * (`idempotency_key`, columna e índice único parcial de la 045), el orden
 * empieza por el producto —`getProduct`, que es lo que comprueba que el registro
 * existe antes de que la marca se resuelva— y sigue con el lookup por marca
 * ANTES de la aritmética y de cualquier escritura. Un reintento del MISMO envío
 * (doble clic, o el navegador reenviando tras cortarse la red) se reconoce y
 * devuelve el movimiento ya registrado como un no-op EXITOSO: no escribe una
 * segunda fila y no mueve el stock otra vez.
 *
 * POR QUÉ EL LOOKUP VA ANTES DE LA ARITMÉTICA: `applyMovementStock` rechaza el
 * OUT que dejaría el stock negativo. Como el primer intento YA movió el stock,
 * un reintento evaluado contra el stock de AHORA moriría con INSUFFICIENT_STOCK
 * —un error por una operación que SÍ se registró—. Es el mismo razonamiento de
 * CL-2/CL-3/CL-5 para las puertas del dinero.
 *
 * POR QUÉ LA MARCA ES OPCIONAL ACÁ: a esta función la llaman también los caminos
 * de FACTURACIÓN, que no tienen un intento propio del cliente y ya están
 * cubiertos por sus propias guardas (la marca de la emisión, el testigo de
 * serialización de la edición, el compare-and-swap de la anulación). La
 * obligatoriedad vive en la frontera manual (`registerManualMovement` /
 * `manualMovementSchema`). El detalle del índice y de la clave está escrito en
 * la 045.
 */
export async function registerMovement(
  raw: unknown,
  actor: MovementActor,
): Promise<RegisterMovementResult> {
  const parsed = movementSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InventoryError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input: MovementInput = parsed.data;
  const db = await inventoryDb();

  const product = await getProduct(input.product_id);

  // CL-6: la MARCA del intento, ANTES de la aritmética y de cualquier
  // escritura. El reintento del MISMO envío trae la misma marca: se devuelve el
  // movimiento ya registrado, sin escribir y sin recalcular contra el stock que
  // el primer intento ya movió. El stock que se informa es el de AHORA (leído
  // en esta misma llamada): el reintento no mueve nada y en el caso real —doble
  // clic o reenvío segundos después, sin otra escritura en el medio— coincide
  // con el que devolvió el primer intento. Es el stock vigente, no una foto de
  // la primera respuesta.
  if (input.idempotency_key) {
    const repeated = await findMovementByIdempotencyKey(
      db,
      input.product_id,
      input.idempotency_key,
    );
    if (repeated) return { movement: repeated, stock_qty: product.stock_qty };
  }

  try {
    applyMovementStock(product.stock_qty, input.type, input.qty);
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_STOCK") {
      throw new InventoryError(
        "INSUFFICIENT_STOCK",
        "Stock insuficiente: el movimiento dejaría el stock negativo.",
        409,
      );
    }
    throw new InventoryError("VALIDATION", "Cantidad inválida.", 400);
  }

  let data: MovementRow | null;
  try {
    data = await db.insertMovement({
      product_id: product.id,
      type: input.type,
      qty: input.qty,
      reason: input.reason,
      user_id: actor.userId,
      // CL-6: la marca del intento. Sin marca queda NULL y la fila queda FUERA
      // del índice parcial de la 045 (los caminos de facturación, que no
      // tienen intento propio, no entran al índice y no compiten con nadie).
      idempotency_key: input.idempotency_key ?? null,
    });
  } catch (error) {
    if (isInsufficientStock(error)) {
      throw new InventoryError(
        "INSUFFICIENT_STOCK",
        "Stock insuficiente: el movimiento dejaría el stock negativo.",
        409,
      );
    }
    // CL-6: carrera perdida contra el índice único parcial de la 045 (23505). El
    // lookup de arriba y este INSERT no son atómicos: si otro envío con la MISMA
    // marca para el MISMO producto se confirmó en esa ventana, la repetición se
    // relee y se devuelve. Sin ganadora, el 23505 NO es una repetición y se
    // reporta como fallo real (INTERNAL) en vez de disfrazarlo de éxito.
    //
    // El chequeo de INSUFFICIENT_STOCK va primero porque el trigger BEFORE ROW
    // del stock (004) corre antes de la comprobación del índice: un OUT que
    // además dejaría el stock negativo llega como INSUFFICIENT_STOCK, no como
    // 23505. Es una ventana declarada (ver la 045): el rechazo es ruidoso y la
    // misma marca sigue reconociendo cuando la guarda se levanta.
    if (
      input.idempotency_key &&
      error instanceof DbQueryError &&
      error.error.code === "23505"
    ) {
      const winner = await findMovementByIdempotencyKey(
        db,
        input.product_id,
        input.idempotency_key,
      );
      if (winner) {
        const current = await getProduct(product.id);
        return { movement: winner, stock_qty: current.stock_qty };
      }
      throw new InventoryError("INTERNAL", "Error interno.", 500);
    }
    throw new InventoryError("INTERNAL", "Error interno.", 500);
  }
  if (!data) throw new InventoryError("INTERNAL", "Error interno.", 500);

  const current = await getProduct(product.id);
  return { movement: data, stock_qty: current.stock_qty };
}

/**
 * B1/FAC-06 (frontera modular): lectura batch de stock para otros módulos.
 * Billing la usa para validar existencia y pre-chequear stock SIN tocar las
 * tablas de inventario directamente. Una sola query con IN (sin N+1).
 */
export interface StockEntry {
  name: string;
  stock_qty: number;
}

export async function getProductsStock(
  productIds: string[],
): Promise<Map<string, StockEntry>> {
  const unique = [...new Set(productIds)];
  if (unique.length === 0) return new Map();
  const rows = await read((db) => db.productStocks(unique));
  return new Map(rows.map((row) => [row.id, { name: row.name, stock_qty: Number(row.stock_qty) }]));
}

function toStockError(error: unknown): InventoryError {
  if (error instanceof InventoryError) return error;
  if (error instanceof Error && error.message === "PRODUCT_NOT_FOUND") {
    return new InventoryError("NOT_FOUND", "Producto no encontrado.", 404);
  }
  if (error instanceof Error && error.message === "INSUFFICIENT_STOCK") {
    const details = (error as { details?: { name?: string; stock?: number; requested?: number } })
      .details;
    return new InventoryError(
      "INSUFFICIENT_STOCK",
      details
        ? `Stock insuficiente para ${details.name}: hay ${details.stock}, se piden ${details.requested}.`
        : "Stock insuficiente para el ajuste.",
      409,
    );
  }
  return new InventoryError("INTERNAL", "Error interno.", 500);
}

/**
 * CL-7: el error del RPC `deduct_stock_atomic` (046) traducido al MISMO
 * contrato de negocio que el plan puro y que el trigger de 004: falta de stock
 * ⇒ 409, producto ausente ⇒ 404, cualquier otra cosa ⇒ INTERNAL.
 *
 * La forma del error es la de PostgREST —un objeto `{code, message, …}`, no un
 * `Error`—, así que no sirve el `instanceof` de `toStockError`: lo único
 * confiable es el mensaje de la `RAISE EXCEPTION` del servidor.
 *
 * El mensaje de la falta de stock es el mismo que ya devolvía el trigger al
 * pasar por `registerMovement`: acá, por definición, el rechazo viene de la
 * CARRERA (el stock cambió después de la lectura con la que el plan validó), y
 * el RPC no puede decir qué producto falló sin otra lectura.
 */
function toRpcDeductionError(error: { message?: unknown } | null): InventoryError {
  const message = String(error?.message ?? "");
  if (message.includes("INSUFFICIENT_STOCK")) {
    return new InventoryError(
      "INSUFFICIENT_STOCK",
      "Stock insuficiente: el movimiento dejaría el stock negativo.",
      409,
    );
  }
  if (message.includes("PRODUCT_NOT_FOUND")) {
    return new InventoryError("NOT_FOUND", "Producto no encontrado.", 404);
  }
  return new InventoryError("INTERNAL", "Error interno.", 500);
}

/**
 * B1/FAC-06 (frontera modular): descuenta stock para una venta.
 * Momento único del descuento: AL EMITIR la factura. Pagar después
 * (splitPayment) NO descuenta; anular revierte con IN; editar ajusta
 * por deltas. Servicios y líneas sin product_id no tocan stock.
 *
 * Valida todo ANTES de mover (existencia, stock suficiente con
 * mensaje por producto, 409, nunca INTERNAL por falta de stock) y luego
 * aplica la deducción ENTERA con una sola llamada al RPC
 * `deduct_stock_atomic` (046).
 *
 * CL-7: POR QUÉ NO ES UN BUCLE. Antes esto era un `registerMovement` por
 * producto: cada uno un request distinto contra PostgREST, con el trigger del
 * stock escribiendo al confirmarse cada uno, así que un fallo a mitad del bucle
 * dejaba los descuentos anteriores YA confirmados —stock y kardex a medias, sin
 * compensación en este camino—. Una función es UNA sentencia y una sentencia
 * corre entera en UNA transacción del servidor: o se aplican TODOS los
 * movimientos, o no se aplica ninguno. Es el mismo mecanismo de 039/040 y la
 * respuesta de la casa a que PostgREST no ofrezca multi-statement.
 *
 * Los movimientos se escriben SIN marca de intento: la deducción de una emisión
 * no tiene intento de cliente, su puerta es la marca de la FACTURA (041) y su
 * fila queda fuera del índice parcial de la 045. La marca opcional de
 * `registerMovement` no se toca: este camino simplemente ya no pasa por ahí.
 */
export async function deductStock(
  actor: MovementActor,
  lines: DeductionLine[],
  reason: string,
): Promise<PlannedDeduction[]> {
  const wanted = [...new Set(lines.map((line) => line.product_id).filter((id): id is string => !!id))];
  // Solo servicios/custom: nada que descontar (no tocan stock).
  if (wanted.length === 0) return [];
  const stockMap = await getProductsStock(wanted);
  const stockByProduct = new Map(
    [...stockMap].map(([id, entry]) => [id, { name: entry.name, stock_qty: entry.stock_qty }]),
  );

  let planned: PlannedDeduction[];
  try {
    planned = planStockDeduction(lines, stockByProduct);
  } catch (error) {
    throw toStockError(error);
  }

  const db = await inventoryDb();
  let applied: unknown;
  try {
    applied = await db.deductStockAtomic(
      actor.userId,
      reason,
      planned.map((item) => ({ product_id: item.product_id, qty: item.qty })),
    );
  } catch (error) {
    throw toRpcDeductionError(error instanceof DbQueryError ? error.error : null);
  }
  // Segunda barrera en la frontera: la función ya revierte si escribió menos de
  // lo pedido, así que un conteo distinto sólo puede venir de una respuesta
  // incoherente. Se reporta como fallo real en vez de devolver un `planned` que
  // la base no aplicó.
  if (typeof applied !== "number" || applied !== planned.length) {
    throw new InventoryError("INTERNAL", "Error interno.", 500);
  }
  return planned;
}

/**
 * Kardex cronológico ascendente de un producto (máx. 200 movimientos).
 *
 * El producto se resuelve ANTES de listar para que un producto que no existe
 * siga siendo NOT_FOUND y no un kardex vacío.
 */
export async function getKardex(
  productId: string,
  limit?: number,
): Promise<MovementRow[]> {
  await getProduct(productId);
  const db = await inventoryDb();
  const rows = sortKardexAscending(await read(() => db.kardex(productId, clampLimit(limit, 200))));
  const actorIds = [...new Set(rows.map((row) => row.user_id).filter((id): id is string => id !== null))];
  const actorNames = new Map<string, string>();
  if (actorIds.length > 0) {
    // Los nombres son decorativos: una lectura fallida deja actor_name en null.
    const users = await db.userNames(actorIds).catch(() => []);
    for (const user of users) actorNames.set(user.id, user.full_name);
  }
  return rows.map((row) => ({
    ...row,
    actor_name: row.user_id ? (actorNames.get(row.user_id) ?? null) : null,
  }));
}

export { requireSession };
