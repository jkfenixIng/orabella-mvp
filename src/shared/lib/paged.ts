/**
 * Lectura exhaustiva contra PostgREST (U5).
 *
 * El Data API de Supabase sirve, por request, la ventana que se le pide y a lo
 * sumo `max-rows` filas (1000 por defecto). Un `.limit(N)` sin `order()` y sin
 * aviso convierte ese tope de TRANSPORTE en un tope de NEGOCIO: la consulta
 * devuelve un conjunto recortado y el código cree haber leído todo. Donde eso
 * decide plata —el cálculo de nómina y el candado que protege una factura ya
 * pagada— el recorte es un error de plata, no de presentación.
 *
 * Acá se lee por páginas, en un orden determinista, hasta agotar el conjunto.
 * `maxRows` NO es un tope de negocio: es la red que corta un bucle infinito si
 * el servidor ignorara la ventana, y al tocarla se falla A LA VISTA, nunca en
 * silencio.
 */

/** Filas por página: el `max-rows` por defecto del Data API de Supabase. */
export const PAGED_READ_PAGE_SIZE = 1000;

/**
 * Máximo de ids por `in(...)`. Los filtros viajan en la URL: una lista de ids
 * sin tope termina en 414 (URI Too Long) y la lectura no ocurre. 100 uuids
 * (~3,7 KB) entran cómodo en los buffers de cabecera habituales.
 */
export const IN_FILTER_CHUNK_SIZE = 100;

/** Techo de seguridad por lectura exhaustiva (falla a la vista, no recorta). */
export const PAGED_READ_MAX_ROWS = 200_000;

/**
 * Una lectura exhaustiva no se pudo completar. Lleva la tabla y la fila donde se
 * cortó para que el error sea accionable, y el fallo original en `cause`.
 */
export class PagedReadError extends Error {
  readonly code = "READ_INCOMPLETE";
  readonly table: string;
  readonly requestedFrom: number;

  constructor(table: string, message: string, requestedFrom: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PagedReadError";
    this.table = table;
    this.requestedFrom = requestedFrom;
  }
}

/** Respuesta mínima de PostgREST que necesita el paginador. */
export interface PagedResponse<TRow> {
  data: TRow[] | null;
  error: {
    code?: string | null;
    message?: string | null;
    details?: string | null;
    hint?: string | null;
  } | null;
}

export interface PagedReadArgs<TRow> {
  /** Tabla leída: solo para el mensaje de error. */
  table: string;
  /** Ventana por request. Nunca mayor que el `max-rows` del servidor. */
  pageSize?: number;
  /** Techo de seguridad (no de negocio). */
  maxRows?: number;
  /**
   * Construye una consulta NUEVA por página, con el `order(...)` que fija el
   * orden, y aplica `.range(from, to)`.
   */
  fetchPage: (from: number, to: number) => PromiseLike<PagedResponse<TRow>>;
}

/**
 * Entrega el conjunto por lotes, en orden, hasta agotarlo. El consumidor puede
 * cortar antes (`return` dentro del `for await`) y así no tener todo el
 * historial en memoria: eso lo usa el candado de nómina cerrada.
 */
export async function* readPagedBatches<TRow>(args: PagedReadArgs<TRow>): AsyncGenerator<TRow[]> {
  const pageSize = args.pageSize ?? PAGED_READ_PAGE_SIZE;
  const maxRows = args.maxRows ?? PAGED_READ_MAX_ROWS;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new PagedReadError(args.table, `Tamaño de página inválido (${pageSize}).`, 0);
  }
  let from = 0;
  let read = 0;
  for (;;) {
    const { data, error } = await args.fetchPage(from, from + pageSize - 1);
    if (error) {
      throw new PagedReadError(
        args.table,
        `La lectura de ${args.table} quedó incompleta en la fila ${from}: ${error.message ?? "error de base de datos"}.`,
        from,
        { cause: error },
      );
    }
    const batch = data ?? [];
    // Más filas que la ventana pedida: el servidor no respetó `range`, así que
    // avanzar la ventana repetiría o perdería filas. Mejor no decidir con eso.
    if (batch.length > pageSize) {
      throw new PagedReadError(
        args.table,
        `La lectura de ${args.table} devolvió ${batch.length} filas para una ventana de ${pageSize}: no se puede garantizar que esté completa.`,
        from,
      );
    }
    read += batch.length;
    yield batch;
    if (batch.length < pageSize) return;
    if (read >= maxRows) {
      throw new PagedReadError(
        args.table,
        `La lectura de ${args.table} superó el techo de seguridad de ${maxRows} filas.`,
        from,
      );
    }
    from += pageSize;
  }
}

/** El conjunto completo (mismo contrato que `readPagedBatches`, sin cortar). */
export async function readAllPaged<TRow>(args: PagedReadArgs<TRow>): Promise<TRow[]> {
  const rows: TRow[] = [];
  for await (const batch of readPagedBatches(args)) rows.push(...batch);
  return rows;
}

/** Parte una lista de ids en lotes del tamaño que aguanta la URL. */
export function chunkIds(ids: readonly string[], size = IN_FILTER_CHUNK_SIZE): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += size) chunks.push(ids.slice(start, start + size));
  return chunks;
}
