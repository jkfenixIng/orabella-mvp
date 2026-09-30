import {
  applyMovementStock,
  filterLowStock,
  manualMovementSchema,
  matchesProductQuery,
  movementSchema,
  normalizeSku,
  planStockDeduction,
  productSchema,
  sortKardexAscending,
  type DeductionLine,
  type MovementInput,
  type MovementType,
  type PlannedDeduction,
  type ProductInput,
} from "./schemas";
import type { RoleCode } from "@/src/features/auth/schemas";
import { getSessionUser } from "@/src/features/auth/service";
import { requireSedeRole, resolveSede } from "@/src/shared/lib/sede";
import { requireSession } from "@/src/features/admin/service";

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

/**
 * Cliente privilegiado bajo demanda (service_role, solo servidor).
 * Import dinámico para que los tests unitarios (sin red/env) nunca lo carguen.
 */
async function inventoryDb() {
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return createAdminClient();
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
 * §10 Inventario: escritura solo admin/caja de su sede; lectura cualquier
 * rol autenticado de su sede (las rutas y actions aplican este gate).
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
export interface ProductRow {
  id: string;
  sede_id: string;
  sku: string;
  name: string;
  description: string | null;
  stock_qty: number;
  min_stock: number;
  cost_price: number | null;
  sale_price: number | null;
  /** I1: comisión sugerida del producto (absoluta); null = sin sugerencia. */
  commission_value: number | null;
  is_active: boolean;
}

const PRODUCT_SELECT =
  "id, sede_id, sku, name, description, stock_qty, min_stock, cost_price, sale_price, commission_value, is_active";
/** Misma selección sin la comisión: la migración 027 aún sin aplicar en esta base. */
const PRODUCT_SELECT_LEGACY =
  "id, sede_id, sku, name, description, stock_qty, min_stock, cost_price, sale_price, is_active";

// I1: commission_value llega con la migración 027. La primera consulta decide y
// se cachea para no repetir la prueba; un error distinto (red/permisos) no se
// cachea, así la consulta real lo reporta en vez de degradar en silencio.
let commissionColumn: boolean | null = null;

async function resolveProductSelect(db: Awaited<ReturnType<typeof inventoryDb>>): Promise<string> {
  if (commissionColumn === null) {
    const probe = await db.from("products").select("commission_value").limit(1);
    if (!probe.error) {
      commissionColumn = true;
    } else {
      const message = String((probe.error as { message?: string }).message ?? "");
      if (/commission_value/i.test(message)) commissionColumn = false;
    }
  }
  return commissionColumn === false ? PRODUCT_SELECT_LEGACY : PRODUCT_SELECT;
}

/** Rellena commission_value cuando la columna no está disponible en esta base. */
function normalizeProduct(row: Record<string, unknown>): ProductRow {
  return {
    ...(row as unknown as ProductRow),
    commission_value: (row.commission_value as number | null) ?? null,
  };
}

/** INV-05 + lectura: lista productos activos e inactivos de la sede (máx. 50 por defecto). */
export async function listProducts(sedeId: string, limit?: number): Promise<ProductRow[]> {
  const db = await inventoryDb();
  const { data, error } = await db
    .from("products")
    .select(await resolveProductSelect(db))
    .eq("sede_id", sedeId)
    .order("name")
    .limit(clampLimit(limit));
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map(normalizeProduct);
}

export async function getProduct(id: string): Promise<ProductRow> {
  const db = await inventoryDb();
  const { data, error } = await db
    .from("products")
    .select(await resolveProductSelect(db))
    .eq("id", id)
    .maybeSingle();
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  if (!data) throw new InventoryError("NOT_FOUND", "Producto no encontrado.", 404);
  return normalizeProduct(data as unknown as Record<string, unknown>);
}

/**
 * INV-01: crea o actualiza un producto (upsert por id). El SKU se
 * normaliza (trim + mayúsculas) y es único por sede: se valida a nivel
 * app para devolver SKU_TAKEN y el UNIQUE (sede_id, sku) cubre carreras.
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

  const conflictQuery = db
    .from("products")
    .select("id")
    .eq("sede_id", input.sede_id)
    .eq("sku", sku)
    .limit(1);
  const { data: conflicts, error: conflictError } = input.id
    ? await conflictQuery.neq("id", input.id)
    : await conflictQuery;
  if (conflictError) throw new InventoryError("INTERNAL", "Error interno.", 500);
  if (conflicts && conflicts.length > 0) {
    throw new InventoryError("SKU_TAKEN", "El SKU ya existe en esta sede.", 409);
  }

  const select = await resolveProductSelect(db);
  const payload = {
    ...(input.id ? { id: input.id } : {}),
    sede_id: input.sede_id,
    sku,
    name: input.name,
    description: input.description ?? null,
    min_stock: input.min_stock,
    cost_price: input.cost_price ?? null,
    sale_price: input.sale_price ?? null,
    // Con la columna ausente (027 sin aplicar) no se envía la comisión.
    ...(select === PRODUCT_SELECT ? { commission_value: input.commission_value ?? null } : {}),
    ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
  };
  const { data, error } = await db
    .from("products")
    .upsert(payload, { onConflict: "id" })
    .select(select)
    .single();
  if (error) {
    // Carrera perdida contra UNIQUE (sede_id, sku): mismo error de negocio.
    if ((error as { code?: string }).code === "23505") {
      throw new InventoryError("SKU_TAKEN", "El SKU ya existe en esta sede.", 409);
    }
    throw new InventoryError("INTERNAL", "Error interno.", 500);
  }
  if (!data) throw new InventoryError("INTERNAL", "Error interno.", 500);
  return normalizeProduct(data as unknown as Record<string, unknown>);
}

/** INV-05: búsqueda por fragmento de nombre o SKU, solo dentro de la sede (máx. 50 por defecto). */
export async function searchProducts(sedeId: string, q: string, limit?: number): Promise<ProductRow[]> {
  const needle = q.trim();
  if (needle === "") return listProducts(sedeId, limit);
  const db = await inventoryDb();
  const escaped = needle.replace(/[%_,\\]/g, (char) => `\\${char}`);
  const pattern = `%${escaped}%`;
  const { data, error } = await db
    .from("products")
    .select(await resolveProductSelect(db))
    .eq("sede_id", sedeId)
    .or(`name.ilike.${pattern},sku.ilike.${pattern}`)
    .order("name")
    .limit(clampLimit(limit));
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  const rows = ((data ?? []) as unknown as Array<Record<string, unknown>>).map(normalizeProduct);
  // Filtro de apoyo en memoria (misma regla que matchesProductQuery).
  return rows.filter((row) => matchesProductQuery(row, needle));
}

/** INV-04: productos con stock en o bajo el mínimo (alerta visible, máx. 200). */
export async function lowStockAlerts(sedeId: string, limit?: number): Promise<ProductRow[]> {
  const db = await inventoryDb();
  const { data, error } = await db
    .from("products")
    .select(await resolveProductSelect(db))
    .eq("sede_id", sedeId)
    .eq("is_active", true)
    .order("stock_qty")
    .limit(clampLimit(limit, 200));
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  return filterLowStock(((data ?? []) as unknown as Array<Record<string, unknown>>).map(normalizeProduct));
}

// ---------------------------------------------------------------- movimientos ---
export interface MovementRow {
  id: string;
  sede_id: string;
  product_id: string;
  type: MovementType;
  qty: number;
  reason: string;
  user_id: string | null;
  actor_name?: string | null;
  created_at: string;
}

const MOVEMENT_SELECT =
  "id, sede_id, product_id, type, qty, reason, user_id, created_at";

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
 * servicio resuelve y valida dentro de la sede del actor ANTES de este lookup—,
 * así que el lookup nunca puede devolver el movimiento de otro producto ni el de
 * otra sede, y la misma marca en dos productos distintos son DOS operaciones.
 * La clave del índice de la 045 es la MISMA (`product_id, idempotency_key`): el
 * `eq` de este lookup y la clave del índice son el mismo conjunto, así que este
 * lookup no puede devolver una fila que el índice no habría bloqueado.
 *
 * La SEDE NO entra en la clave porque no agrega identidad: `products.sede_id`
 * determina la sede de la fila y el servicio exige que sea la del actor
 * (`resolveSedeOrThrow`) antes de llegar acá, así que la marca se resuelve dentro
 * del tenant que la usó y este lookup no puede filtrar el movimiento de otra
 * sede. La MISMA marca para OTRO producto es OTRA operación (agregar la sede a
 * la clave, en cambio, colapsaría dos movimientos legítimos de productos
 * distintos de la misma sede bajo una sola marca, y devolvería el movimiento del
 * producto equivocado como si fuera la repetición del que se pidió).
 */
async function findMovementByIdempotencyKey(
  db: Awaited<ReturnType<typeof inventoryDb>>,
  productId: string,
  idempotencyKey: string,
): Promise<MovementRow | null> {
  const { data, error } = await db
    .from("inventory_movements")
    .select(MOVEMENT_SELECT)
    .eq("product_id", productId)
    .eq("idempotency_key", idempotencyKey)
    .limit(1)
    .maybeSingle();
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  return (data as MovementRow | null) ?? null;
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
  actor: { userId: string; sedeId: string },
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
 * empieza por el producto —`getProduct` + `resolveSedeOrThrow`, que es lo que
 * valida el registro dentro de la sede del actor, así el lookup no puede
 * devolver el movimiento de otra sede— y sigue con el lookup por marca ANTES de
 * la aritmética y de cualquier escritura. Un reintento del MISMO envío (doble
 * clic, o el navegador reenviando tras cortarse la red) se reconoce y devuelve
 * el movimiento ya registrado como un no-op EXITOSO: no escribe una segunda
 * fila y no mueve el stock otra vez.
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
  actor: { userId: string; sedeId: string },
): Promise<RegisterMovementResult> {
  const parsed = movementSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InventoryError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input: MovementInput = parsed.data;
  const db = await inventoryDb();

  const product = await getProduct(input.product_id);
  resolveSedeOrThrow(actor.sedeId, product.sede_id);

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

  const { data, error } = await db
    .from("inventory_movements")
    .insert({
      sede_id: product.sede_id,
      product_id: product.id,
      type: input.type,
      qty: input.qty,
      reason: input.reason,
      user_id: actor.userId,
      // CL-6: la marca del intento. Sin marca queda NULL y la fila queda FUERA
      // del índice parcial de la 045 (los caminos de facturación, que no
      // tienen intento propio, no entran al índice y no compiten con nadie).
      idempotency_key: input.idempotency_key ?? null,
    })
    .select(MOVEMENT_SELECT)
    .single();
  if (error) {
    if (typeof error.message === "string" && error.message.includes("INSUFFICIENT_STOCK")) {
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
      (error as { code?: string } | null)?.code === "23505"
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
  return { movement: data as MovementRow, stock_qty: current.stock_qty };
}

/**
 * B1/FAC-06 (frontera modular): lectura batch de stock para otros módulos.
 * Billing la usa para validar existencia/sede y pre-chequear stock SIN
 * tocar las tablas de inventario directamente. Una sola query con IN
 * (sin N+1); el mapa solo incluye productos de la sede indicada.
 */
export interface StockEntry {
  name: string;
  stock_qty: number;
  sede_id: string;
}

export async function getProductsStock(
  sedeId: string,
  productIds: string[],
): Promise<Map<string, StockEntry>> {
  const unique = [...new Set(productIds)];
  if (unique.length === 0) return new Map();
  const db = await inventoryDb();
  const { data, error } = await db
    .from("products")
    .select("id, sede_id, name, stock_qty")
    .eq("sede_id", sedeId)
    .in("id", unique);
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  return new Map(
    ((data ?? []) as Array<{ id: string; sede_id: string; name: string; stock_qty: number }>).map(
      (row) => [row.id, { name: row.name, stock_qty: Number(row.stock_qty), sede_id: row.sede_id }],
    ),
  );
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
 * Valida todo ANTES de mover (existencia, sede, stock suficiente con
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
  actor: { userId: string; sedeId: string },
  lines: DeductionLine[],
  reason: string,
): Promise<PlannedDeduction[]> {
  const wanted = [...new Set(lines.map((line) => line.product_id).filter((id): id is string => !!id))];
  // Solo servicios/custom: nada que descontar (no tocan stock).
  if (wanted.length === 0) return [];
  const stockMap = await getProductsStock(actor.sedeId, wanted);
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
  const { data: applied, error } = await db.rpc("deduct_stock_atomic", {
    p_sede_id: actor.sedeId,
    p_user_id: actor.userId,
    p_reason: reason,
    p_items: planned.map((item) => ({ product_id: item.product_id, qty: item.qty })),
  });
  if (error) throw toRpcDeductionError(error as { message?: unknown } | null);
  // Segunda barrera en la frontera: la función ya revierte si escribió menos de
  // lo pedido, así que un conteo distinto sólo puede venir de una respuesta
  // incoherente. Se reporta como fallo real en vez de devolver un `planned` que
  // la base no aplicó.
  if (typeof applied !== "number" || applied !== planned.length) {
    throw new InventoryError("INTERNAL", "Error interno.", 500);
  }
  return planned;
}

function resolveSedeOrThrow(sessionSedeId: string, rowSedeId: string): void {
  try {
    resolveSede(sessionSedeId, rowSedeId);
  } catch {
    throw new InventoryError("FORBIDDEN", "No tiene acceso a esa sede.", 403);
  }
}

/** Kardex cronológico ascendente de un producto (solo su sede, máx. 200 movimientos). */
export async function getKardex(
  sedeId: string,
  productId: string,
  limit?: number,
): Promise<MovementRow[]> {
  const product = await getProduct(productId);
  resolveSedeOrThrow(sedeId, product.sede_id);
  const db = await inventoryDb();
  const { data, error } = await db
    .from("inventory_movements")
    .select(MOVEMENT_SELECT)
    .eq("product_id", productId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(clampLimit(limit, 200));
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  const rows = sortKardexAscending((data ?? []) as MovementRow[]);
  const actorIds = [...new Set(rows.map((row) => row.user_id).filter((id): id is string => id !== null))];
  const actorNames = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: users } = await db.from("users").select("id, full_name").in("id", actorIds);
    for (const user of ((users ?? []) as Array<{ id: string; full_name: string }>)) {
      actorNames.set(user.id, user.full_name);
    }
  }
  return rows.map((row) => ({
    ...row,
    actor_name: row.user_id ? (actorNames.get(row.user_id) ?? null) : null,
  }));
}

export { requireSession };
