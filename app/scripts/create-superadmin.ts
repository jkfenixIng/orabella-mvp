/**
 * G2 — alta o actualización de la CUENTA de plataforma `superadmin`.
 *
 * QUÉ HACE
 *   Deja en la base UNA cuenta con el rol de plataforma `superadmin` (069) y con
 *   la clave que traiga la variable de entorno. Es idempotente: la primera
 *   corrida la crea y las siguientes actualizan su clave; nunca crea una segunda
 *   cuenta ni duplica el rol.
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
 * LA SEDE (por qué es obligatoria y no tiene respaldo)
 *   `users.sede_id` es NOT NULL (003_admin.sql): toda cuenta pertenece a una
 *   sede, también la de plataforma —el rol es ADICIONAL, no una sede nueva—.
 *   La sede viene en `SUPERADMIN_SEDE_ID` y NO tiene valor por defecto: un
 *   respaldo silencioso ("la primera sede") es la forma de dejar la cuenta en la
 *   sede equivocada sin que nadie lo note. Si el id no existe en `sedes`, el
 *   script falla antes de escribir.
 *
 * EL DESTINO (por qué hay que declararlo)
 *   `SUPERADMIN_TARGET` (`pruebas` | `produccion`) es la confirmación explícita
 *   de a qué instalación se le va a escribir: el script se niega a correr sin
 *   ella y la imprime junto con el host de Supabase al que apunta. Un script de
 *   credenciales que adivina su destino es el que termina creando la cuenta de
 *   producción con la clave de pruebas.
 *
 * QUÉ ESCRIBE (y qué no)
 *   * Crea la cuenta con `create_user_with_role` (054): `users` + `user_roles`
 *     en UNA sentencia, igual que el alta de la app. No hay inserts a mano.
 *   * Aplica el rol con `replace_user_roles` (039) en los DOS caminos y
 *     contrasta el conjunto que la base devuelve: si no es exactamente
 *     `superadmin`, falla. La cuenta queda con ese rol y ningún otro.
 *   * Deja `must_change_password = false`: AUTH-01 pide cambio obligatorio
 *     cuando la clave inicial es el documento, pero acá la clave es la del
 *     entorno y el despliegue ya la eligió; con el cambio forzado la clave
 *     desplegada sería de un solo uso y volver a correr el script la repondría.
 *   * Limpia el bloqueo (`locked_until`, `failed_attempts`): es la salida
 *     operativa cuando la cuenta quedó bloqueada por intentos.
 *   * NO habilita una cuenta deshabilitada (`is_active = false`): eso es una
 *     decisión del dueño y el script falla en vez de deshacerla en silencio.
 *   * NO escribe auditoría: el vocabulario de `audit_logs` no tiene una acción
 *     de aprovisionamiento y este script no es una operación de la aplicación.
 *
 * CÓMO SE CORRE
 *   `npm run create:superadmin` con las variables en el entorno de la corrida
 *   (ver el README de la app). No lee `.env.local`: el entorno de la corrida es
 *   el que se declara a mano, y nadie quiere que un archivo local decida contra
 *   qué base se escribe una credencial.
 */

import { z } from "zod";
import { esRechazoDeRpc, hashPassword, verifyPassword } from "@/src/features/auth/service";

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
/** El rol de plataforma del catálogo (069). */
export const ROL_PLATAFORMA = "superadmin";

export const VAR_CLAVE = "SUPERADMIN_PASSWORD";
export const VAR_SEDE = "SUPERADMIN_SEDE_ID";
export const VAR_DESTINO = "SUPERADMIN_TARGET";

/**
 * ÚNICO destino declarable. La lista se deriva del esquema —y no se escribe dos
 * veces— para que agregar un entorno no deje un valor válido sin declarar
 * (mismo criterio que `SEDE_ASSIGNABLE_ROLES` en auth/schemas.ts).
 */
export const destinoSchema = z.enum(["pruebas", "produccion"]);
export type DestinoPlataforma = z.infer<typeof destinoSchema>;
export const DESTINOS: readonly DestinoPlataforma[] = destinoSchema.options;

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

/**
 * El uuid de la sede. Acá SÍ se recortan espacios: es un identificador, no una
 * credencial, y un salto de línea de un archivo de despliegue no puede cambiar
 * qué sede se eligió.
 */
export function leerSede(env: Entorno): string {
  const sede = env[VAR_SEDE]?.trim();
  if (!sede) {
    throw new SuperadminError(
      "SEDE_AUSENTE",
      `${VAR_SEDE} no está definida: la cuenta de plataforma también pertenece a una sede (users.sede_id es NOT NULL) y no hay sede por defecto.`,
    );
  }
  const parsed = z.uuid().safeParse(sede);
  if (!parsed.success) {
    throw new SuperadminError(
      "SEDE_INVALIDA",
      `${VAR_SEDE} no es un uuid válido. Use el id de la fila de public.sedes.`,
    );
  }
  return parsed.data;
}

export function leerDestino(env: Entorno): DestinoPlataforma {
  const destino = env[VAR_DESTINO]?.trim();
  if (!destino) {
    throw new SuperadminError(
      "DESTINO_AUSENTE",
      `${VAR_DESTINO} no está definida: escriba "pruebas" o "produccion" para declarar a qué instalación se le va a escribir.`,
    );
  }
  const parsed = destinoSchema.safeParse(destino);
  if (!parsed.success) {
    throw new SuperadminError(
      "DESTINO_DESCONOCIDO",
      `${VAR_DESTINO} debe ser "pruebas" o "produccion", no "${destino}".`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------- contra la base ---

export interface ResultadoAprovisionamiento {
  /** `creada` la primera vez, `actualizada` en las corridas siguientes. */
  accion: "creada" | "actualizada";
  userId: string;
  sedeNombre: string;
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
 * Deja la cuenta de plataforma con la clave recibida. Idempotente por
 * construcción: primero LEE la cuenta por documento y decide entre crear y
 * actualizar; la unicidad de `users.id_number` (002) es la red de la base si dos
 * procesos llegan a la vez.
 */
export async function provisionarSuperadmin(args: {
  clave: string;
  sedeId: string;
}): Promise<ResultadoAprovisionamiento> {
  const db = await adminDb();

  // 1. La sede tiene que EXISTIR. `users.sede_id` es NOT NULL con FK a `sedes`:
  //    un uuid inventado haría fallar el alta —o, peor, dejaría la cuenta sin
  //    sede si algún día la columna se relajara—, así que se comprueba antes de
  //    escribir una sola fila.
  const { data: sedeData, error: sedeError } = await db
    .from("sedes")
    .select("id, name")
    .eq("id", args.sedeId)
    .maybeSingle();
  if (sedeError) {
    throw new SuperadminError("LECTURA_FALLIDA", `No se pudo leer la sede: ${sedeError.message}`);
  }
  if (!sedeData) {
    throw new SuperadminError(
      "SEDE_DESCONOCIDA",
      `No hay ninguna sede con id ${args.sedeId}. Consulte el catálogo (select id, name from public.sedes) y vuelva a intentar.`,
    );
  }
  const sede = sedeData as { id: string; name: string };

  // 2. ¿Ya existe la cuenta? La decisión crear/actualizar sale de esta lectura.
  const { data: cuentaData, error: cuentaError } = await db
    .from("users")
    .select("id, is_active")
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
    const cuenta = cuentaData as { id: string; is_active: boolean };
    if (!cuenta.is_active) {
      throw new SuperadminError(
        "CUENTA_INACTIVA",
        `La cuenta ${DOCUMENTO_PLATAFORMA} existe pero está deshabilitada (users.is_active = false). El script no deshace esa decisión: habilítela a mano si eso es lo que quiere.`,
      );
    }
    userId = cuenta.id;
    accion = "actualizada";
  }

  // 4. La credencial y el estado de acceso, en UNA escritura. Se hacen en los
  //    DOS caminos —también en el alta— para que el estado final sea el mismo y
  //    no dependa de cuál de los dos caminos se tomó.
  const { error: credencialError } = await db
    .from("users")
    .update({
      password_hash: claveHash,
      // AUTH-01 fuerza el cambio cuando la clave inicial es el documento; acá la
      // clave la eligió el despliegue y debe servir para entrar.
      must_change_password: false,
      failed_attempts: 0,
      locked_until: null,
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
  //    rol de plataforma y ningún otro, en cada corrida.
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
    .select("password_hash, must_change_password")
    .eq("id", userId)
    .maybeSingle();
  if (guardadoError || !guardadoData) {
    throw new SuperadminError(
      "VERIFICACION_FALLIDA",
      `No se pudo releer la credencial guardada: ${guardadoError?.message ?? "la cuenta no está"}.`,
    );
  }
  const guardado = guardadoData as { password_hash: string; must_change_password: boolean };
  if (
    !(await verifyPassword(args.clave, guardado.password_hash)) ||
    guardado.must_change_password
  ) {
    throw new SuperadminError(
      "CREDENCIAL_NO_VERIFICA",
      "La clave guardada no verifica contra la del entorno. Revise la variable y vuelva a intentar.",
    );
  }

  return { accion, userId, sedeNombre: sede.name, roles };
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
 * Punto de entrada. NUNCA imprime la clave ni el hash: solo el destino, la sede
 * y lo que quedó escrito.
 */
export async function main(): Promise<void> {
  try {
    const clave = leerClave(process.env);
    const sedeId = leerSede(process.env);
    const destino = leerDestino(process.env);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!url) {
      throw new SuperadminError(
        "SUPABASE_SIN_CONFIGURAR",
        "Falta NEXT_PUBLIC_SUPABASE_URL (ver README): sin ese dato no se sabe a qué instalación se le va a escribir.",
      );
    }

    console.log(`[superadmin] destino declarado: ${destino} — Supabase: ${hostDe(url)}`);
    if (destino === "produccion") {
      console.log("[superadmin] PRODUCCIÓN: esta corrida escribe en la base de producción.");
    }
    console.log(`[superadmin] sede: ${sedeId}`);

    const resultado = await provisionarSuperadmin({ clave, sedeId });

    console.log(
      `[superadmin] cuenta ${DOCUMENTO_PLATAFORMA} ${resultado.accion}: usuario ${resultado.userId} — sede ${resultado.sedeNombre} — roles [${resultado.roles.join(", ")}]`,
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
