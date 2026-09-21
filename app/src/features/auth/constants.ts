/**
 * Constantes auth sin dependencias Node (edge-safe).
 * `service.ts` las re-exporta; el middleware y las páginas las importan
 * desde aquí para no arrastrar `node:crypto` al bundle Edge.
 */

/** AUTH-05: 5 fallos -> bloqueo temporal. */
export const MAX_LOGIN_ATTEMPTS = 5;
/** Ventana del rate-limit en memoria por documento (AUTH-05, NFR-03). */
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
/** Duración del bloqueo por intentos fallidos (locked_until). */
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
/** AUTH-03: vigencia máxima de la sesión. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** AUTH-03: timeout por inactividad (last_activity_at). */
export const SESSION_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
/** AUTH-06: vigencia del token de recuperación (un solo uso). */
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

export const SESSION_COOKIE_NAME = "orabella_session";

/** Error genérico: nunca revela si el documento existe (AUTH-01/05). */
export const GENERIC_LOGIN_ERROR = "Documento o clave inválidos.";
export const ACCOUNT_LOCKED_ERROR =
  "Cuenta bloqueada temporalmente por intentos fallidos. Intente más tarde.";
