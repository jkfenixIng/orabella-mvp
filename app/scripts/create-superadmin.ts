/**
 * G2 — alta o actualización de la CUENTA de plataforma `superadmin`.
 *
 * QUÉ HACE
 *   Deja en la base UNA cuenta con el rol de plataforma `superadmin` (069) y con
 *   la clave que traiga la variable de entorno, anclada a LA SEDE DE LA
 *   INSTALACIÓN. Es idempotente: la primera corrida la crea y las siguientes
 *   actualizan su clave; nunca crea una segunda cuenta ni duplica el rol.
 *
 * POR QUÉ ES UN SCRIPT Y NO PARTE DEL ALTA DE USUARIOS
 *   `adminCreateUser` (auth/service.ts) NO puede crear esta cuenta: su esquema
 *   solo admite los tres roles de sede, exige correo real y espeja el alta en
 *   Supabase Auth. El rol `superadmin` es de PLATAFORMA y no se otorga desde la
 *   administración de una sede (G1). Este script es la ÚNICA puerta que lo
 *   otorga, y por eso vive fuera de la app: no es superficie de la aplicación y
 *   ninguna acción ni ruta puede importarlo.
 *
 * DE DÓNDE SALE LA CREDENCIAL (decisión del dueño, 2026-10-01)
 *   De `SUPERADMIN_PASSWORD`, y SÓLO de ahí: no hay clave por defecto ni
 *   respaldo. Si la variable falta o viene vacía, el script NO escribe nada y
 *   falla. La clave no se imprime, no se registra y no existe en ningún archivo
 *   del repositorio: lo único que queda escrito es su hash scrypt, calculado con
 *   `hashPassword()` de la app —el mismo módulo cuyo `verifyPassword()` usa el
 *   login—, para que el hash no pueda divergir del que la aplicación espera.
 *
 * LA SEDE DE LA INSTALACIÓN (decisión del dueño 2026-10-01: una sola sede)
 *   `users.sede_id` es NOT NULL (003_admin.sql), así que la cuenta tiene que
 *   pertenecer a ALGUNA sede. Con la instalación de una sola sede, esa sede es
 *   LA SEDE DEL NEGOCIO: no hace falta ni una fila de sistema que la represente ni
 *   una sentinel que la inventara. Por eso el script NO crea ninguna fila de
 *   `sedes` —no escribe en esa tabla— y se ancla a la que ya existe.
 *
 *   * La resolución es la MISMA que usa la capa de plataforma
 *     (`leerSedeDeLaInstalacion`, `src/features/platform/service.ts`): la única
 *     fila ACTIVA de `sedes`. Se decide por DATO (`is_active`), nunca por el
 *     nombre de la fila: renombrarla no cambia lo que es la instalación.
 *   * Si no hay exactamente una sede activa, el script FALLA ANTES de tocar la
 *     cuenta: cero no hay dónde anclar, y dos o más ya no es una instalación de
 *     una sola sede. Ninguna de las dos cosas la decide el script.
 *   * Las filas INACTIVAS que queden (p. ej. la que esta misma capa creó antes de
 *     la decisión, `Plataforma (sistema)`) no son la instalación y el script no
 *     las toca, no las cuenta y no las ofrece: su limpieza es de la unidad que
 *     elimina la columna.
 *   * NO se relaja `users.sede_id` ni se toca `requireSedeRole`
 *     (`src/shared/lib/sede.ts`): el aislamiento de las rutas del negocio sigue
 *     sosteniéndose por esa columna. Para el negocio la cuenta sigue siendo un
 *     usuario de su sede; el privilegio de plataforma viene del ROL (G1), y su
 *     rol no se puede cambiar desde la administración de la sede (`setUserRoles`).
 *     Las guardas son PURAS sobre `sede_id` y no miran `sedes.is_active`.
 *
 * QUÉ ESCRIBE (y qué no)
 *   * Crea la cuenta con `create_user_with_role` (054): `users` + `user_roles`
 *     en UNA sentencia, igual que el alta de la app. No hay inserts a mano.
 *   * Aplica el rol con `replace_user_roles` (039) en los DOS caminos y
 *     contrasta el conjunto que la base devuelve: si no es exactamente
 *     `superadmin`, falla. Esa ES la definición de la cuenta: ajusta el sistema
 *     y NO opera el negocio —caja, facturas y nómina le quedan sin permisos, a
 *     propósito—, así que el conjunto no se amplía nunca.
 *   * Deja `must_change_password = false`: AUTH-01 pide cambio obligatorio
 *     cuando la clave inicial es el documento, pero acá la clave es la del
 *     entorno y el despliegue ya la eligió; con el cambio forzado la clave
 *     desplegada sería de un solo uso y volver a correr el script la repondría.
 *   * Limpia el bloqueo (`locked_until`, `failed_attempts`): es la salida
 *     operativa cuando la cuenta quedó bloqueada por intentos.
 *   * Re-ancla la cuenta a la sede de la instalación si estaba en otra sede, y
 *     lo dice (cambiar de sede cambia lo que esa cuenta ve del negocio: no puede ser
 *     silencioso).
 *   * NO habilita una cuenta deshabilitada (`is_active = false`): eso es una
 *     decisión del dueño y el script falla en vez de deshacerla en silencio.
 *   * NO escribe auditoría: el vocabulario de `audit_logs` no tiene una acción
 *     de aprovisionamiento y este script no es una operación de la aplicación.
 *
 * DE DÓNDE SALEN LAS CREDENCIALES DE SUPABASE (y de dónde NO)
 *   El script CARGA los archivos de entorno del proyecto con el mecanismo
 *   canónico de Next (`loadEnvConfig` de `@next/env`, que ya viene con `next`),
 *   así que `NEXT_PUBLIC_SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` salen de
 *   `.env.local` sin pegarlas a mano en el terminal —que es la fricción que
 *   termina en la clave pegada en el lugar equivocado o en la base equivocada—.
 *   Imprime los NOMBRES de los archivos que cargó (nunca valores) para que se
 *   sepa de dónde salieron las credenciales.
 *
 *   PRECEDENCIA: lo que YA está en el entorno del proceso GANA sobre el archivo.
 *   `@next/env` ya lo hace así (trabaja sobre un snapshot del entorno); acá se
 *   vuelve a imponer de forma explícita para que la garantía esté escrita y
 *   probada en este archivo, y no heredada de un detalle interno. Así el dueño
 *   puede apuntar a otra base a propósito sin editar archivos.
 *
 *   `SUPERADMIN_PASSWORD` NO va en ningún archivo: es la credencial y se define
 *   en el entorno de la corrida (ver el README). El cargador la leería si
 *   estuviera en `.env.local`, y por eso el README dice que no se ponga ahí.
 *
 * CÓMO SE CORRE
 *   `npm run create:superadmin`. El script imprime de qué archivos de entorno
 *   salieron las credenciales y el host de Supabase ANTES de escribir: ese es el
 *   chequeo humano de a qué instalación le escribe.
 */

import { basename } from "node:path";
import { loadEnvConfig } from "@next/env";
import { esRechazoDeRpc, hashPassword, verifyPassword } from "@/src/features/auth/service";
import {
  leerSedeDeLaInstalacion,
  PlatformError,
  type PlatformDb,
} from "@/src/features/platform/service";

// ---------------------------------------------------------------- contrato ---

/**
 * El documento con el que se entra: la app autentica por `users.id_number`
 * (login por documento, ver README de auth). Es el MISMO en PRUEBAS y en
 * producción: lo que cambia por entorno es la clave, no la cuenta.
 */
export const DOCUMENTO_PLATAFORMA = "superadmin";
/** Nombre visible de la cuenta. No es una persona: es la cuenta de la plataforma. */
export const NOMBRE_PLATAFORMA = "Administración de plataforma";
/** `otro` es el único tipo de identificación honesto: no es un documento de nadie. */
export const TIPO_ID_PLATAFORMA = "otro";
/** El rol de plataforma del catálogo (069). Es el ÚNICO rol de esta cuenta. */
export const ROL_PLATAFORMA = "superadmin";

export const VAR_CLAVE = "SUPERADMIN_PASSWORD";

/** Fallo de NEGOCIO del script: `codigo` es el contrato que las pruebas fijan. */
export class SuperadminError extends Error {
  readonly codigo: string;

  constructor(codigo: string, mensaje: string) {
    super(mensaje);
    this.name = "SuperadminError";
    this.codigo = codigo;
  }
}

type Entorno = Record<string, string | undefined>;

// ------------------------------------------------------ entorno del proyecto ---

/**
 * Lo que el script necesita del cargador de entorno (el resto de la firma de
 * `loadEnvConfig` es opcional). Se declara para poder inyectarlo en las pruebas
 * sin tocar el disco ni los archivos de entorno reales.
 */
export type CargadorDeEntorno = (
  dir: string,
  dev?: boolean,
  log?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
) => { loadedEnvFiles: Array<{ path: string }> };

/**
 * Logger del cargador: silencia el ruido normal de Next, pero NO sus fallos. Un
 * archivo ilegible o mal formado tiene que verse, prefijado y en su contexto.
 */
const LOGGER_DE_ENTORNO = {
  info: () => {},
  error: (...args: unknown[]) => console.error("[superadmin] entorno:", ...args),
};

/**
 * Carga los archivos de entorno del proyecto —la MISMA lista que arma Next según
 * `NODE_ENV` (con `.env.local` entre ellos; en `NODE_ENV=test` Next lo omite)— y
 * devuelve sus NOMBRES, que son lo único que el script imprime de ellos.
 *
 * PRECEDENCIA: se guarda el entorno que YA tenía el proceso y se vuelve a imponer
 * después de cargar, así lo que el shell declaró gana sobre el archivo y el dueño
 * puede apuntar a otra base a propósito. `@next/env` ya respeta esa precedencia;
 * hacerlo acá deja la garantía escrita y probada en vez de heredada.
 */
export function cargarEntornoDeProyecto(
  dir: string = process.cwd(),
  cargar: CargadorDeEntorno = loadEnvConfig,
): string[] {
  const previas = { ...process.env };
  const { loadedEnvFiles } = cargar(dir, undefined, LOGGER_DE_ENTORNO);
  for (const [clave, valor] of Object.entries(previas)) {
    if (valor !== undefined) process.env[clave] = valor;
  }
  return loadedEnvFiles.map((archivo) => basename(archivo.path));
}

// ---------------------------------------------------------------- entradas ---

/**
 * La clave, TAL CUAL viene: no se recorta. Un espacio al final es parte de la
 * clave, y recortarlo en silencio dejaría una credencial distinta de la que el
 * operador escribió —con un hash que verifica contra otra cosa—. Solo se
 * rechaza lo que no puede ser una clave: ausente o vacía (o solo espacios).
 */
export function leerClave(env: Entorno): string {
  const clave = env[VAR_CLAVE];
  if (clave === undefined || clave.trim().length === 0) {
    throw new SuperadminError(
      "CLAVE_AUSENTE",
      `${VAR_CLAVE} no está definida o está vacía. No hay clave por defecto: defina la variable del entorno y vuelva a intentar.`,
    );
  }
  return clave;
}

// ---------------------------------------------------------- contra la base ---

export interface SedeDeLaInstalacion {
  id: string;
  name: string;
}

export interface ResultadoAprovisionamiento {
  /** `creada` la primera vez, `actualizada` en las corridas siguientes. */
  accion: "creada" | "actualizada";
  userId: string;
  sede: SedeDeLaInstalacion;
  /** Lo que hay que decir en voz alta. Vacío cuando no hubo nada que avisar. */
  avisos: string[];
  /** El conjunto que la base confirmó que aplicó (contraste de `replace_user_roles`). */
  roles: string[];
}

/**
 * Cliente privilegiado bajo demanda (service_role, solo servidor), con el mismo
 * patrón que `auth/service.ts:261`: import dinámico para que las pruebas
 * unitarias —sin red ni env— nunca lo carguen.
 */
async function adminDb() {
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return createAdminClient();
}

/**
 * Resuelve LA SEDE DE LA INSTALACIÓN con la MISMA regla que usa la capa de
 * plataforma (`leerSedeDeLaInstalacion`): la única fila activa de `sedes`. El
 * script no crea, no modifica y no cuenta filas de `sedes` — sólo necesita saber
 * a cuál anclar la cuenta— y traduce los dos estados imposibles a su propio
 * contrato de errores de CLI.
 */
async function sedeDeLaInstalacion(db: PlatformDb): Promise<SedeDeLaInstalacion> {
  try {
    const sede = await leerSedeDeLaInstalacion(db);
    return { id: sede.id, name: sede.name };
  } catch (error) {
    if (error instanceof PlatformError && error.code === "NOT_FOUND") {
      throw new SuperadminError(
        "SEDE_AUSENTE",
        "La instalación no tiene ninguna sede activa: active la sede del negocio y vuelva a intentar.",
      );
    }
    if (error instanceof PlatformError && error.code === "SEDE_AMBIGUA") {
      throw new SuperadminError("SEDE_DUPLICADA", error.message);
    }
    throw new SuperadminError(
      "LECTURA_FALLIDA",
      `No se pudo resolver la sede de la instalación: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Deja la cuenta de plataforma con la clave recibida, anclada a la sede de la
 * instalación. Idempotente por construcción: primero resuelve esa sede, después
 * LEE la cuenta por documento y decide entre crear y actualizar; la unicidad de
 * `users.id_number` (002) es la red de la base si dos procesos llegan a la vez.
 */
export async function provisionarSuperadmin(args: {
  clave: string;
}): Promise<ResultadoAprovisionamiento> {
  const db = await adminDb();

  // 1. La SEDE DE LA INSTALACIÓN, ANTES de tocar la cuenta: una cuenta sin sede
  //    no puede existir (`users.sede_id` es NOT NULL) y una instalación a medias
  //    es peor que un script que no corrió.
  const sede = await sedeDeLaInstalacion(db);

  const avisos: string[] = [];

  // 2. ¿Ya existe la cuenta? La decisión crear/actualizar sale de esta lectura.
  const { data: cuentaData, error: cuentaError } = await db
    .from("users")
    .select("id, sede_id, is_active")
    .eq("id_number", DOCUMENTO_PLATAFORMA)
    .maybeSingle();
  if (cuentaError) {
    throw new SuperadminError(
      "LECTURA_FALLIDA",
      `No se pudo leer la cuenta ${DOCUMENTO_PLATAFORMA}: ${cuentaError.message}`,
    );
  }

  // El hash lo calcula la APP (scrypt, `hashPassword`), nunca una copia: es lo
  // único que garantiza que `verifyPassword` del login acepte esta credencial.
  const claveHash = await hashPassword(args.clave);

  let userId: string;
  let accion: ResultadoAprovisionamiento["accion"];

  if (!cuentaData) {
    // 3a. Alta: `users` + `user_roles` en UNA sentencia (054), y con el rol
    //     pedido adentro —una cuenta sin rol es el estado que 039/040 existen
    //     para hacer imposible—. Sin `email`: `users.email` es UNIQUE y la
    //     cuenta es solo-documento; un correo sintético está prohibido por la
    //     decisión de auth (ver README).
    const { data: creado, error } = await db.rpc("create_user_with_role", {
      p_user: {
        sede_id: sede.id,
        id_type: TIPO_ID_PLATAFORMA,
        id_number: DOCUMENTO_PLATAFORMA,
        password_hash: claveHash,
        full_name: NOMBRE_PLATAFORMA,
      },
      p_role_codes: [ROL_PLATAFORMA],
    });
    if (error) {
      if (esRechazoDeRpc(error, "ROLE_NOT_FOUND")) {
        throw new SuperadminError(
          "CATALOGO_SIN_ROL",
          `El catálogo de roles no tiene \`${ROL_PLATAFORMA}\`: aplique la migración 069 en esta base y vuelva a intentar.`,
        );
      }
      if (esRechazoDeRpc(error, "USER_EXISTS")) {
        throw new SuperadminError(
          "CUENTA_OCUPADA",
          `Otra escritura creó la cuenta ${DOCUMENTO_PLATAFORMA} entre la lectura y el alta. Vuelva a ejecutar el script: la próxima corrida la actualiza.`,
        );
      }
      throw new SuperadminError("ALTA_FALLIDA", `No se pudo crear la cuenta: ${error.message}`);
    }
    if (typeof creado !== "string" || creado.length === 0) {
      throw new SuperadminError("ALTA_FALLIDA", "El alta no devolvió el id de la cuenta.");
    }
    userId = creado;
    accion = "creada";
  } else {
    // 3b. Actualización. Una cuenta deshabilitada NO se rehabilita acá.
    const cuenta = cuentaData as { id: string; sede_id: string | null; is_active: boolean };
    if (!cuenta.is_active) {
      throw new SuperadminError(
        "CUENTA_INACTIVA",
        `La cuenta ${DOCUMENTO_PLATAFORMA} existe pero está deshabilitada (users.is_active = false). El script no deshace esa decisión: habilítela a mano si eso es lo que quiere.`,
      );
    }
    if (cuenta.sede_id !== sede.id) {
      // Cambiar de sede cambia lo que la cuenta ve del negocio: se hace, porque
      // la cuenta es de plataforma, pero se DICE.
      avisos.push(
        `la cuenta estaba anclada a otra sede (${cuenta.sede_id ?? "sin sede"}): se ancló a "${sede.name}", la sede de la instalación.`,
      );
    }
    userId = cuenta.id;
    accion = "actualizada";
  }

  // 4. La credencial, el estado de acceso y la SEDE, en UNA escritura. Se hacen
  //    en los DOS caminos —también en el alta— para que el estado final sea el
  //    mismo y no dependa de cuál de los dos caminos se tomó.
  const { error: credencialError } = await db
    .from("users")
    .update({
      password_hash: claveHash,
      // AUTH-01 fuerza el cambio cuando la clave inicial es el documento; acá la
      // clave la eligió el despliegue y debe servir para entrar.
      must_change_password: false,
      failed_attempts: 0,
      locked_until: null,
      sede_id: sede.id,
    })
    .eq("id", userId);
  if (credencialError) {
    throw new SuperadminError(
      "CREDENCIAL_FALLIDA",
      `No se pudo escribir la credencial: ${credencialError.message}`,
    );
  }

  // 5. El rol de plataforma, aplicado y CONTRASTADO con lo que la base devuelve:
  //    `replace_user_roles` (039) es la función de la casa para escribir roles y
  //    su retorno es el conjunto aplicado —el llamador no da por hecho lo que
  //    pidió—. Reemplazar (y no agregar) es deliberado: la cuenta queda con el
  //    rol de plataforma y ningún otro, en cada corrida. Esa es su definición.
  const { data: rolesData, error: rolError } = await db.rpc("replace_user_roles", {
    p_user_id: userId,
    p_role_codes: [ROL_PLATAFORMA],
  });
  if (rolError) {
    if (esRechazoDeRpc(rolError, "ROLE_NOT_FOUND")) {
      throw new SuperadminError(
        "CATALOGO_SIN_ROL",
        `El catálogo de roles no tiene \`${ROL_PLATAFORMA}\`: aplique la migración 069 en esta base y vuelva a intentar.`,
      );
    }
    throw new SuperadminError("ROL_FALLIDO", `No se pudo aplicar el rol: ${rolError.message}`);
  }
  const roles = Array.isArray(rolesData)
    ? rolesData.filter((code): code is string => typeof code === "string")
    : [];
  if (roles.length !== 1 || roles[0] !== ROL_PLATAFORMA) {
    throw new SuperadminError(
      "ROL_NO_APLICADO",
      `La base aplicó [${roles.join(", ")}] en vez de [${ROL_PLATAFORMA}]. Revise los roles de la cuenta antes de usarla.`,
    );
  }

  // 6. La post-condición de la unidad: la clave del ENTORNO tiene que verificar
  //    contra el hash que quedó guardado, con la MISMA función del login. Si esto
  //    no se cumple, el script falla a propósito: una cuenta que no puede entrar
  //    con la clave desplegada es peor que un script que no corrió.
  const { data: guardadoData, error: guardadoError } = await db
    .from("users")
    .select("password_hash, must_change_password, sede_id")
    .eq("id", userId)
    .maybeSingle();
  if (guardadoError || !guardadoData) {
    throw new SuperadminError(
      "VERIFICACION_FALLIDA",
      `No se pudo releer la credencial guardada: ${guardadoError?.message ?? "la cuenta no está"}.`,
    );
  }
  const guardado = guardadoData as {
    password_hash: string;
    must_change_password: boolean;
    sede_id: string | null;
  };
  if (
    !(await verifyPassword(args.clave, guardado.password_hash)) ||
    guardado.must_change_password
  ) {
    throw new SuperadminError(
      "CREDENCIAL_NO_VERIFICA",
      "La clave guardada no verifica contra la del entorno. Revise la variable y vuelva a intentar.",
    );
  }
  if (guardado.sede_id !== sede.id) {
    throw new SuperadminError(
      "SEDE_NO_ANCLADA",
      `La cuenta quedó en la sede ${guardado.sede_id ?? "sin sede"} en vez de "${sede.name}", la sede de la instalación.`,
    );
  }

  return { accion, userId, sede, avisos, roles };
}

// -------------------------------------------------------------------- CLI ---

/** El host del proyecto de Supabase: es lo que el operador mira antes de escribir. */
function hostDe(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new SuperadminError(
      "SUPABASE_SIN_CONFIGURAR",
      "NEXT_PUBLIC_SUPABASE_URL no es una URL válida (ver README).",
    );
  }
}

/**
 * Punto de entrada. NUNCA imprime la clave ni el hash: solo de dónde salió el
 * entorno, el host de destino, la sede y lo que quedó escrito.
 */
export async function main(cargar?: CargadorDeEntorno): Promise<void> {
  try {
    // PRIMERO el entorno: de acá salen la URL y la service_role key (y hasta la
    // clave, si alguien la puso en un archivo). Después de esto, cualquier
    // lectura de `process.env` ve lo que dejaron los archivos, con el shell
    // ganando sobre ellos.
    const archivos = cargarEntornoDeProyecto(process.cwd(), cargar);
    console.log(
      archivos.length > 0
        ? `[superadmin] entorno: archivos cargados: ${archivos.join(", ")} — el entorno del proceso tiene prioridad sobre ellos`
        : "[superadmin] entorno: no se encontraron archivos de entorno; se usa sólo el entorno del proceso",
    );

    const clave = leerClave(process.env);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!url) {
      throw new SuperadminError(
        "SUPABASE_SIN_CONFIGURAR",
        "Falta NEXT_PUBLIC_SUPABASE_URL (ver README): sin ese dato no se sabe a qué instalación se le va a escribir.",
      );
    }

    // El host, ANTES de escribir: es el chequeo humano de a qué base se le
    // escribe (cada entorno tiene su propio `.env`).
    console.log(`[superadmin] Supabase: ${hostDe(url)}`);

    const resultado = await provisionarSuperadmin({ clave });

    console.log(
      `[superadmin] sede de la instalación: ${resultado.sede.name} — ${resultado.sede.id}`,
    );
    for (const aviso of resultado.avisos) console.warn(`[superadmin] AVISO: ${aviso}`);
    console.log(
      `[superadmin] cuenta ${DOCUMENTO_PLATAFORMA} ${resultado.accion}: usuario ${resultado.userId} — roles [${resultado.roles.join(", ")}]`,
    );
    console.log(
      "[superadmin] la clave del entorno verifica contra el hash guardado (scrypt, hashPassword de la app).",
    );
  } catch (error) {
    const mensaje =
      error instanceof SuperadminError
        ? `[${error.codigo}] ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`[superadmin] ERROR: ${mensaje}`);
    process.exitCode = 1;
  }
}

/**
 * Ejecución directa (`tsx`/`jiti` sobre este archivo). El script del
 * `package.json` NO depende de esto: importa el módulo y llama a `main()`, y con
 * `node -e` no hay `process.argv[1]`. Las pruebas importan el módulo y por eso
 * tampoco lo disparan.
 */
const argv1 = process.argv[1] ?? "";
if (/scripts[\\/]create-superadmin\.(ts|js)$/.test(argv1)) {
  void main();
}
