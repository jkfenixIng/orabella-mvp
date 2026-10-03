import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_ACTIONS,
  ALERT_MODULES,
  ALERTS_PAGE_SIZE,
  alertDateBounds,
  VOUCHER_ALERT_ACTION,
  VOUCHER_ALERT_ENTITY,
  alertsQuerySchema,
  assembleShiftRevision,
  buildVoucherAlertResolution,
  reviewNoteSchema,
  rollbackAlertDetail,
  voucherAlertFilter,
  voucherAlertRequired,
  voucherAlertResolutionNote,
} from "@/src/features/alerts/schemas";
import { AlertError, markAlertRead, resolveVoucherAlert } from "@/src/features/alerts/service";
import { approveVoucher, rejectVoucher } from "@/src/features/payroll/service";
import { AUDIT_ACTIONS } from "@/src/shared/lib/audit";

/* --------------------------------------------------------------------------
   Doble de PostgREST para la ESCRITURA de la bandeja, con dos reglas que son
   la prueba:

   1. Las filas se guardan TAL COMO LAS ESCRIBE el rastro hoy —sin `sede_id`—,
      así que una escritura acotada por sede no tiene con qué coincidir y
      PostgREST responde `null` (cero filas), igual que en la base real. Antes
      los dobles sólo contaban escrituras y por eso nadie notó que "marcar como
      leída" llevaba meses sin tocar nada.
   2. `.eq` FILTRA de verdad contra la fila, como el servidor: el filtro es lo
      que decide si la escritura existe, no un adorno registrado.
   -------------------------------------------------------------------------- */

/** Constructor mínimo de la consulta, con la misma superficie que usa el módulo. */
interface AlertaQuery {
  select: (proyeccion: string) => AlertaQuery;
  update: (patch: Record<string, unknown>) => AlertaQuery;
  insert: (payload: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  eq: (columna: string, valor: unknown) => AlertaQuery;
  in: (columna: string, valores: unknown[]) => AlertaQuery;
  match: (valores: Record<string, unknown>) => AlertaQuery;
  single: () => Promise<{ data: unknown; error: unknown }>;
  limit: (cantidad: number) => AlertaQuery;
  gte: (columna: string, valor: unknown) => AlertaQuery;
  lte: (columna: string, valor: unknown) => AlertaQuery;
  order: (columna: string, opciones?: { ascending?: boolean }) => AlertaQuery;
  range: (desde: number, hasta: number) => AlertaQuery;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  then: (
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
}

const dbStub = vi.hoisted(() => {
  const stub = {
    filas: [] as Array<Record<string, unknown>>,
    /** Escrituras que APARECIERON (una fila coincidió) con su filtro. */
    escrituras: [] as Array<{
      tabla: string;
      patch: Record<string, unknown>;
      filtros: Record<string, unknown>;
    }>,
    /** Filas insertadas por el rastro, tal como salen del payload. */
    inserts: [] as Array<{ tabla: string; payload: Record<string, unknown> }>,
    /** Fallo de la base, si la prueba lo pide. */
    error: null as { message: string } | null,
    from: (tabla: string): AlertaQuery => {
      let columnas: string[] = [];
      let patch: Record<string, unknown> | null = null;
      const filtros: Record<string, unknown> = {};
      const listas: Array<{ columna: string; valores: unknown[] }> = [];

      const cumple = (fila: Record<string, unknown>): boolean =>
        Object.entries(filtros).every(([columna, valor]) => fila[columna] === valor) &&
        listas.every(({ columna, valores }) => valores.includes(fila[columna]));

      const proyectar = (filas: Array<Record<string, unknown>>) =>
        columnas.length === 0
          ? filas
          : filas.map((fila) =>
              Object.fromEntries(columnas.map((columna) => [columna, fila[columna]])),
            );

      const resolverFila = (): { data: unknown; error: unknown } => {
        if (stub.error) return { data: null, error: stub.error };
        const fila = stub.filas.filter(cumple)[0] ?? null;
        if (fila === null) return { data: null, error: null };
        // La escritura se APLICA al resolver, como en PostgREST.
        if (patch) {
          stub.escrituras.push({ tabla, patch, filtros: { ...filtros } });
          Object.assign(fila, patch);
        }
        return { data: proyectar([fila])[0], error: null };
      };

      const resolverLista = (): { data: unknown; error: unknown } => {
        if (stub.error) return { data: null, error: stub.error };
        const encontradas = stub.filas.filter(cumple);
        // Un UPDATE sin `.select()` no devuelve filas, pero SÍ escribe sobre
        // todas las que coinciden: sin esto, el cierre de la alerta del vale
        // (un `.match()` sin proyección) parecería no tocar nada.
        if (patch) {
          for (const fila of encontradas) {
            stub.escrituras.push({ tabla, patch, filtros: { ...filtros } });
            Object.assign(fila, patch);
          }
          return { data: null, error: null };
        }
        return { data: proyectar(encontradas), error: null };
      };

      const query: AlertaQuery = {
        select: (proyeccion: string) => {
          columnas = proyeccion
            .split(",")
            .map((columna) => columna.trim())
            .filter(Boolean);
          return query;
        },
        update: (valores: Record<string, unknown>) => {
          patch = valores;
          return query;
        },
        eq: (columna: string, valor: unknown) => {
          filtros[columna] = valor;
          return query;
        },
        in: (columna: string, valores: unknown[]) => {
          listas.push({ columna, valores });
          return query;
        },
        // `.match()` es el AND de las igualdades que trae, como en PostgREST:
        // se apoya en el MISMO `cumple` de `.eq`, así que una clave que la fila
        // no tiene (por ejemplo `sede_id`) deja la consulta sin coincidencia en
        // vez de decorarla.
        match: (valores: Record<string, unknown>) => {
          for (const [columna, valor] of Object.entries(valores)) filtros[columna] = valor;
          return query;
        },
        insert: (payload: Record<string, unknown>) => {
          if (!stub.error) stub.inserts.push({ tabla, payload: { ...payload } });
          return Promise.resolve({ data: null, error: stub.error });
        },
        single: () => Promise.resolve(resolverFila()),
        // `limit` no interviene en el alcance que se prueba acá: se acepta para
        // que las llamadas de otros módulos no se rompan, sin filtrar.
        limit: () => query,
        gte: () => query,
        lte: () => query,
        order: () => query,
        range: () => query,
        maybeSingle: () => Promise.resolve(resolverFila()),
        then: (onFulfilled, onRejected) =>
          Promise.resolve(resolverLista()).then(onFulfilled, onRejected),
      };
      return query;
    },
  };
  return stub;
});

vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => ({ from: dbStub.from }),
}));

/** Alerta de desajuste tal como la deja el rastro: identificado y SIN sede. */
function filaAlerta(id: string): Record<string, unknown> {
  return {
    id,
    action: "cash.shift_open_mismatch",
    entity: "cash_shifts",
    entity_id: `turno-${id}`,
    metadata: {},
    user_id: "caja-1",
    is_read: false,
    read_at: null,
    review_note: null,
    reviewed_by: null,
    created_at: "2026-10-02T15:00:00.000Z",
  };
}

describe("alerts: revisar la alerta no se acota por sede", () => {
  beforeEach(() => {
    dbStub.filas = [filaAlerta("alerta-1"), filaAlerta("alerta-2")];
    dbStub.escrituras = [];
    dbStub.error = null;
  });

  it("escribe sobre la fila que trae el id, aunque el rastro no lleve sede", async () => {
    // La fila no tiene `sede_id` (así la escribe el rastro hoy). Si el servicio
    // la buscara por sede, el UPDATE no hallaría fila alguna y esto recibe `null`.
    expect(dbStub.filas[0]).not.toHaveProperty("sede_id");

    const resultado = await markAlertRead(
      "alerta-1",
      { note: "Hablé con caja, el faltante está justificado." },
      { userId: "admin-1" },
    );

    expect(resultado).toEqual({ id: "alerta-1" });
    expect(dbStub.escrituras).toHaveLength(1);
    expect(dbStub.escrituras[0]?.tabla).toBe("audit_logs");
    // El alcance de la escritura es la fila Y SOLO la fila: por `id`, sin sede.
    expect(dbStub.escrituras[0]?.filtros).toEqual({ id: "alerta-1" });
    expect(Object.keys(dbStub.escrituras[0]?.filtros ?? {})).not.toContain("sede_id");
    expect(dbStub.escrituras[0]?.patch).toMatchObject({
      is_read: true,
      review_note: "Hablé con caja, el faltante está justificado.",
      reviewed_by: "admin-1",
    });
    expect(typeof dbStub.escrituras[0]?.patch.read_at).toBe("string");
  });

  it("la revisión sí cambia la fila, y sólo esa", async () => {
    await markAlertRead("alerta-2", { note: "Revisado." }, { userId: "admin-1" });

    const revisada = dbStub.filas.find((fila) => fila.id === "alerta-2");
    const otra = dbStub.filas.find((fila) => fila.id === "alerta-1");
    expect(revisada?.is_read).toBe(true);
    expect(revisada?.reviewed_by).toBe("admin-1");
    expect(otra?.is_read).toBe(false);
    expect(otra?.reviewed_by).toBeNull();
  });

  it("control negativo: una escritura acotada por sede NO alcanza ninguna fila", async () => {
    // La misma consulta con el alcance que se acaba de quitar, a mano: el doble
    // tiene que DELATARLA. Si este control dejara de detectar el filtro, la
    // prueba de arriba no valdría nada (haría falta un guard como este).
    const acotada = await dbStub
      .from("audit_logs")
      .update({ is_read: true, review_note: "Alcance por sede." })
      .eq("id", "alerta-1")
      .eq("sede_id", "sede-1")
      .select("id")
      .maybeSingle();

    expect(acotada.data).toBeNull();
    expect(dbStub.escrituras).toHaveLength(0);
    expect(dbStub.filas[0]?.is_read).toBe(false);
    // Y el guard del guard: sin esta fila, el control podría pasar por casualidad.
    expect(() => expect(acotada.data).not.toBeNull()).toThrow();
  });

  it("el servicio ya no pide sede (la firma es la del rastro actual)", () => {
    expect(markAlertRead.length).toBe(3);
  });

  it("sin fila: NOT_FOUND 404; sin justificación: VALIDATION 400", async () => {
    const ausente = await markAlertRead(
      "alerta-9",
      { note: "No existe." },
      { userId: "admin-1" },
    ).catch((error: unknown) => error);
    expect(ausente).toBeInstanceOf(AlertError);
    expect((ausente as AlertError).code).toBe("NOT_FOUND");
    expect((ausente as AlertError).status).toBe(404);
    expect(dbStub.escrituras).toHaveLength(0);

    const sinNota = await markAlertRead("alerta-1", { note: "   " }, { userId: "admin-1" }).catch(
      (error: unknown) => error,
    );
    expect(sinNota).toBeInstanceOf(AlertError);
    expect((sinNota as AlertError).code).toBe("VALIDATION");
    expect((sinNota as AlertError).status).toBe(400);
    expect(dbStub.escrituras).toHaveLength(0);
  });
});

describe("alerts: conjunto de alerta y paginado", () => {
  it("cubre desajustes de caja, bloqueos, vales por revisar y el residuo de alta, página fija de 10", () => {
    expect([...ALERT_ACTIONS]).toEqual([
      "cash.shift_open_mismatch",
      "cash.shift_close_mismatch",
      "auth.login_locked",
      "voucher.requested",
      "auth.user_create_rollback_failed",
    ]);
    expect(ALERTS_PAGE_SIZE).toBe(10);
  });

  it("la comisión pagada no es alerta: fuera del catálogo, de los módulos y del conjunto de `.in`", () => {
    const comisionPagada = "payroll.commission_paid";
    // Sigue siendo traza de auditoría (el vocabulario compartido no se toca),
    // pero ya no interrumpe la bandeja ni suma a la insignia ni al módulo Caja.
    expect(AUDIT_ACTIONS.COMMISSION_PAID).toBe(comisionPagada);
    expect([...ALERT_ACTIONS]).not.toContain(comisionPagada);
    expect([...ALERT_MODULES.caja.actions]).not.toContain(comisionPagada);
    // El conjunto que `service.ts` pasa a `.in("action", acciones)`: sin módulo
    // usa ALERT_ACTIONS; con módulo, las acciones de ese módulo.
    const conjuntosDeFiltro = [
      [...ALERT_ACTIONS],
      ...Object.values(ALERT_MODULES).map((modulo) => [...modulo.actions]),
    ];
    for (const conjunto of conjuntosDeFiltro) {
      expect(conjunto).not.toContain(comisionPagada);
    }
    // Control negativo: si alguien la reincorpora, el guard falla (test en rojo).
    expect(() =>
      expect([...ALERT_ACTIONS, comisionPagada]).not.toContain(comisionPagada),
    ).toThrow();
    expect(() =>
      expect([...ALERT_MODULES.caja.actions, comisionPagada]).not.toContain(comisionPagada),
    ).toThrow();
  });

  it("página 1 y todas por defecto; rechaza página inválida", () => {
    const parsed = alertsQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ unreadOnly: false, page: 1 });
    }
    expect(alertsQuerySchema.safeParse({ page: 2 }).success).toBe(true);
    expect(alertsQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(alertsQuerySchema.safeParse({ unreadOnly: true }).success).toBe(true);
  });

  it("revisar exige justificación no vacía de hasta 500", () => {    expect(reviewNoteSchema.safeParse({ note: "Hablé con caja, faltante justificado." }).success).toBe(true);
    expect(reviewNoteSchema.safeParse({ note: "   " }).success).toBe(false);
    expect(reviewNoteSchema.safeParse({}).success).toBe(false);
    expect(reviewNoteSchema.safeParse({ note: "x".repeat(501) }).success).toBe(false);
  });

  it("cada alerta pertenece a exactamente un módulo (sin mezclas)", () => {
    const flat = [...ALERT_MODULES.caja.actions, ...ALERT_MODULES.acceso.actions];
    expect([...flat].sort()).toEqual([...ALERT_ACTIONS].sort());
    expect(new Set(flat).size).toBe(flat.length);
    expect(alertsQuerySchema.safeParse({ module: "caja" }).success).toBe(true);
    expect(alertsQuerySchema.safeParse({ module: "otro" }).success).toBe(false);
  });

  it("revisión del turno: null sin desajustes, Sí solo con todas leídas", () => {
    expect(assembleShiftRevision([], false)).toBeNull();
    expect(
      assembleShiftRevision([], true),
    ).toEqual({ revisada: false, notas: [] });
    expect(
      assembleShiftRevision(
        [{ action: "cash.shift_close_mismatch", fecha: "2026-09-22T01:00:00Z", revisada: true, justificacion: "Hablado.", revisor: "Ana" }],
        false,
      ),
    ).toEqual({
      revisada: true,
      notas: [{ accion: "Cierre", fecha: "2026-09-22T01:00:00Z", nota: "Hablado.", revisor: "Ana" }],
    });
    expect(
      assembleShiftRevision(
        [
          { action: "cash.shift_open_mismatch", fecha: "2026-09-22T01:00:00Z", revisada: true, justificacion: "Apertura ok.", revisor: "Ana" },
          { action: "cash.shift_close_mismatch", fecha: "2026-09-22T02:00:00Z", revisada: false, justificacion: null, revisor: null },
        ],
        true,
      )?.revisada,
    ).toBe(false);
  });
});

describe("alerts: filtro por rango de fechas", () => {
  it("acepta desde/hasta opcionales y los conserva", () => {
    const parsed = alertsQuerySchema.safeParse({
      unreadOnly: true,
      module: "caja",
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        unreadOnly: true,
        page: 1,
        module: "caja",
        from: "2026-09-01",
        to: "2026-09-30",
      });
    }
  });

  it("acepta un solo extremo y sin rango (comportamiento anterior intacto)", () => {
    expect(alertsQuerySchema.safeParse({ from: "2026-09-01" }).success).toBe(true);
    expect(alertsQuerySchema.safeParse({ to: "2026-09-30" }).success).toBe(true);
    const parsed = alertsQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ unreadOnly: false, page: 1 });
    }
  });

  it("rechaza fechas inválidas y rango invertido por el camino de validación", () => {
    expect(alertsQuerySchema.safeParse({ from: "01-09-2026" }).success).toBe(false);
    expect(alertsQuerySchema.safeParse({ to: "septiembre" }).success).toBe(false);
    const inverted = alertsQuerySchema.safeParse({ from: "2026-09-30", to: "2026-09-01" });
    expect(inverted.success).toBe(false);
    if (!inverted.success) {
      expect(inverted.error.issues[0]?.message).toBe("El rango de fechas es inválido.");
    }
  });

  it("módulo+sin leer siguen intactos, también combinados con rango", () => {
    const parsed = alertsQuerySchema.safeParse({
      unreadOnly: true,
      module: "acceso",
      page: 2,
      from: "2026-09-01",
      to: "2026-09-01",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        unreadOnly: true,
        page: 2,
        module: "acceso",
        from: "2026-09-01",
        to: "2026-09-01",
      });
    }
    expect(alertsQuerySchema.safeParse({ module: "otro" }).success).toBe(false);
  });

  it("la ventana es inclusiva en hora de Bogotá (cubre el día completo)", () => {
    expect(alertDateBounds("2026-09-01", "2026-09-30")).toEqual({
      from: "2026-09-01T00:00:00-05:00",
      to: "2026-09-30T23:59:59.999-05:00",
    });
    expect(alertDateBounds()).toEqual({});
    expect(alertDateBounds("2026-09-01")).toEqual({ from: "2026-09-01T00:00:00-05:00" });
    expect(alertDateBounds(undefined, "2026-09-30")).toEqual({
      to: "2026-09-30T23:59:59.999-05:00",
    });
  });
});

describe("alerts: el residuo de un alta fallida avisa (CL-18)", () => {
  it("la acción del residuo está en el vocabulario compartido y en la bandeja", () => {
    // Una sola acción, compartida por el auditor y la bandeja: si divergieran,
    // el residuo volvería a ser invisible (el defecto que CL-18 cierra).
    expect(AUDIT_ACTIONS.USER_CREATE_ROLLBACK_FAILED).toBe("auth.user_create_rollback_failed");
    expect([...ALERT_ACTIONS]).toContain(AUDIT_ACTIONS.USER_CREATE_ROLLBACK_FAILED);
    expect([...ALERT_MODULES.acceso.actions]).toContain(
      AUDIT_ACTIONS.USER_CREATE_ROLLBACK_FAILED,
    );
  });

  it("cada alerta sigue perteneciendo a un solo módulo, incluido el residuo", () => {
    expect([...ALERT_MODULES.acceso.actions]).toContain(AUDIT_ACTIONS.USER_CREATE_ROLLBACK_FAILED);
    expect([...ALERT_MODULES.caja.actions]).not.toContain(
      AUDIT_ACTIONS.USER_CREATE_ROLLBACK_FAILED,
    );
  });

  it("el detalle nombra al usuario que quedó y el motivo, sin filtrar un documento", () => {
    expect(rollbackAlertDetail({ email: "ana@orabella.co", motivo: "email_exists" })).toBe(
      "El alta falló y su compensación también: quedó el usuario ana@orabella.co para reparar (motivo: email_exists).",
    );
    // Sin correo ni motivo el aviso sigue siendo legible (nunca "undefined").
    expect(rollbackAlertDetail({})).toBe(
      "El alta falló y su compensación también: quedó el usuario sin correo registrado para reparar.",
    );
  });
});

describe("alerts: la alerta del vale se resuelve al aprobarlo o rechazarlo", () => {
  it("solo un vale fuera de rango (pendiente) deja alerta; dentro de rango no", () => {
    // requestVoucher nace aprobada (dentro de rango) o pendiente (fuera);
    // solo la pendiente escribe la alerta voucher.requested.
    expect(voucherAlertRequired("pendiente")).toBe(true);
    expect(voucherAlertRequired("aprobada")).toBe(false);
    expect(voucherAlertRequired("rechazada")).toBe(false);
    expect(voucherAlertRequired("descontada")).toBe(false);
  });

  it("la alerta del vale vive en el vocabulario y módulo de la bandeja", () => {
    expect([...ALERT_ACTIONS]).toContain(VOUCHER_ALERT_ACTION);
    expect([...ALERT_MODULES.caja.actions]).toContain(VOUCHER_ALERT_ACTION);
    expect(VOUCHER_ALERT_ENTITY).toBe("voucher_requests");
  });

  it("el cierre reutiliza is_read/read_at/review_note/reviewed_by (sin estados nuevos)", () => {
    const patch = buildVoucherAlertResolution({
      reviewedBy: "admin-1",
      note: "Vale aprobado.",
      now: "2026-01-02T03:04:05.000Z",
    });
    expect(patch).toEqual({
      is_read: true,
      read_at: "2026-01-02T03:04:05.000Z",
      review_note: "Vale aprobado.",
      reviewed_by: "admin-1",
    });
  });

  it("nota de resolución: aprobado y rechazado con su motivo", () => {
    expect(voucherAlertResolutionNote("aprobada")).toBe("Vale aprobado.");
    expect(voucherAlertResolutionNote("rechazada")).toBe("Vale rechazado.");
    expect(voucherAlertResolutionNote("rechazada", "sin soporte")).toBe(
      "Vale rechazado: sin soporte",
    );
    expect(voucherAlertResolutionNote("rechazada", "   ")).toBe("Vale rechazado.");
  });

  it("el cierre toca SOLO la alerta pendiente de ESE vale (idempotente, sin duplicar)", () => {
    // ASSERTION INVERTIDA A PROPÓSITO. Antes fijaba que el filtro LLEVABA
    // `sede_id`, y eso fijaba el defecto: el rastro se escribe sin esa columna
    // (una sola instalación), así que ese alcance no podía alcanzar ninguna
    // fila y el vale quedaba aprobado o rechazado con su alerta abierta, sin
    // que nadie se enterara. Bendecir ese filtro era bendecir una consulta que
    // nunca surtía efecto, así que ahora se fija lo contrario: el filtro NO
    // lleva sede, y conserva el resto del alcance.
    expect(voucherAlertFilter("vale-9")).toEqual({
      action: VOUCHER_ALERT_ACTION,
      entity: VOUCHER_ALERT_ENTITY,
      entity_id: "vale-9",
      is_read: false,
    });
    // Lo que no puede volver a aparecer es la columna que el rastro no tiene.
    expect(Object.keys(voucherAlertFilter("vale-9"))).not.toContain("sede_id");
    // Otro vale queda fuera del filtro: aprobar uno no cierra la alerta de otro.
    const other = voucherAlertFilter("vale-10");
    expect(other.entity_id).not.toBe("vale-9");
    // Y la firma es la del rastro actual: ni el filtro ni el cierre piden sede.
    expect(voucherAlertFilter.length).toBe(1);
    expect(resolveVoucherAlert.length).toBe(3);
  });
});

/* --------------------------------------------------------------------------
   EL FLUJO REAL: revisar un vale deja leída la alerta que abrió.

   Nada ejercitaba `resolveVoucherAlert`, y no se puede probar por
   `tests/payroll.test.ts`: su doble registra las escrituras SIN sus filtros
   (`{ table, payload }`), así que un alcance por sede aparecería como una
   escritura más y la prueba pasaría en falso. Acá el doble filtra de verdad
   (`.eq` y `.match`), y la fila se siembra TAL COMO la escribe el rastro, sin
   `sede_id`: por eso la prueba del cierre puede delatar un alcance por sede.
   -------------------------------------------------------------------------- */

const SEDE = "sede-1";
const ACTOR = { userId: "admin-1", roles: ["admin" as const] };

/** Vale pendiente de revisar, como lo guarda `voucher_requests`. */
function filaVoucher(id: string): Record<string, unknown> {
  return {
    id,
    sede_id: SEDE,
    employee_id: "emp-1",
    amount: 120000,
    request_date: "2026-01-15",
    status: "pendiente",
    approved_by: null,
    approval_code: null,
    observation: null,
    method_code: "efectivo",
    cash_shift_id: null,
    created_by: null,
  };
}

/** La alerta de la bandeja, escrita como la escribe `writeAudit`: SIN sede. */
function filaAlertaDeVale(voucherId: string, id: string): Record<string, unknown> {
  return {
    id,
    action: VOUCHER_ALERT_ACTION,
    entity: VOUCHER_ALERT_ENTITY,
    entity_id: voucherId,
    metadata: {},
    user_id: "emp-1",
    is_read: false,
    read_at: null,
    review_note: null,
    reviewed_by: null,
    created_at: "2026-01-15T13:00:00.000Z",
  };
}

describe("alerts: aprobar o rechazar un vale deja leída SU alerta", () => {
  beforeEach(() => {
    dbStub.filas = [
      filaVoucher("vale-9"),
      filaAlertaDeVale("vale-9", "alerta-9"),
      // La alerta de otro vale: aprobar uno no puede cerrar la del otro.
      filaAlertaDeVale("vale-10", "alerta-10"),
    ];
    dbStub.escrituras = [];
    dbStub.inserts = [];
    dbStub.error = null;
  });

  it("aprobar un vale deja leída la alerta que abrió, y solo la suya", async () => {
    const aprobado = await approveVoucher("vale-9", {}, ACTOR);

    expect(aprobado.status).toBe("aprobada");
    const propia = dbStub.filas.find((fila) => fila.id === "alerta-9");
    const ajena = dbStub.filas.find((fila) => fila.id === "alerta-10");
    expect(propia?.is_read).toBe(true);
    expect(propia?.reviewed_by).toBe("admin-1");
    expect(propia?.review_note).toBe("Vale aprobado.");
    expect(typeof propia?.read_at).toBe("string");
    expect(ajena?.is_read).toBe(false);

    // El rastro de la aprobación se escribe SIN sede (la premisa del defecto):
    // si algún día volviera a llevarla, el cierre volvería a no alcanzar fila.
    const rastro = dbStub.inserts.find((entrada) => entrada.tabla === "audit_logs");
    expect(rastro).toBeDefined();
    expect(rastro?.payload).toMatchObject({
      action: AUDIT_ACTIONS.VOUCHER_APPROVED,
      entity: "voucher_requests",
      entity_id: "vale-9",
    });
    expect(Object.keys(rastro?.payload ?? {})).not.toContain("sede_id");

    // Y el cierre se hizo con el alcance real: por la fila, sin sede.
    const cierre = dbStub.escrituras.find((entrada) => entrada.tabla === "audit_logs");
    expect(cierre?.filtros).toEqual({
      action: VOUCHER_ALERT_ACTION,
      entity: VOUCHER_ALERT_ENTITY,
      entity_id: "vale-9",
      is_read: false,
    });
    expect(Object.keys(cierre?.filtros ?? {})).not.toContain("sede_id");
  });

  it("rechazar un vale deja leída su alerta, con el motivo de la revisión", async () => {
    const rechazado = await rejectVoucher("vale-9", { motivo: "sin soporte" }, ACTOR);

    expect(rechazado.status).toBe("rechazada");
    const propia = dbStub.filas.find((fila) => fila.id === "alerta-9");
    expect(propia?.is_read).toBe(true);
    expect(propia?.reviewed_by).toBe("admin-1");
    expect(propia?.review_note).toBe("Vale rechazado: sin soporte");
    expect(dbStub.filas.find((fila) => fila.id === "alerta-10")?.is_read).toBe(false);
  });

  it("cerrar dos veces no inventa nada: el segundo cierre no vuelve a escribir", async () => {
    await approveVoucher("vale-9", {}, ACTOR);
    const escriturasDelPrimerCierre = dbStub.escrituras.length;

    const segundo = await resolveVoucherAlert(
      "vale-9",
      ACTOR.userId,
      voucherAlertResolutionNote("aprobada"),
    );

    expect(segundo).toEqual({ resolved: true });
    expect(dbStub.escrituras).toHaveLength(escriturasDelPrimerCierre);
    expect(dbStub.filas.find((fila) => fila.id === "alerta-9")?.is_read).toBe(true);
  });

  it("control negativo: el MISMO cierre con alcance por sede no alcanza ninguna fila", async () => {
    // La fila del rastro no tiene `sede_id`, así que un filtro que la exija no
    // puede coincidir: la alerta quedaría abierta y el vale, aprobado. Si este
    // control dejara de detectar el alcance por sede, las pruebas de arriba no
    // valdrían nada (haría falta un guard como este).
    expect(dbStub.filas.find((fila) => fila.id === "alerta-9")).not.toHaveProperty("sede_id");

    const porSede = await dbStub
      .from("audit_logs")
      .update(buildVoucherAlertResolution({ reviewedBy: "admin-1", note: "Alcance por sede." }))
      .match({ ...voucherAlertFilter("vale-9"), sede_id: SEDE })
      .select("id")
      .maybeSingle();

    expect(porSede.data).toBeNull();
    expect(dbStub.escrituras).toHaveLength(0);
    expect(dbStub.filas.find((fila) => fila.id === "alerta-9")?.is_read).toBe(false);
    // Y el guard del guard: sin esta fila, el control podría pasar por casualidad.
    expect(() => expect(porSede.data).not.toBeNull()).toThrow();
  });
});
