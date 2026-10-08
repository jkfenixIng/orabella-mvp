/**
 * T8 — Rate-limit externo con fallback a memoria (NFR-03, PRD §6/§11).
 *
 * Backend preferido: Upstash Redis vía REST (sin dependencias: `fetch`
 * nativo) cuando existen `UPSTASH_REDIS_REST_URL` y
 * `UPSTASH_REDIS_REST_TOKEN`. Sin ellas, fallback a memoria del proceso con
 * advertencia en log (válido en dev / instancia única; en serverless
 * multi-instancia cada réplica cuenta por separado — configurar Upstash).
 *
 * SOLO SERVIDOR. Se usa en login y password-reset (5 intentos / 15 min por
 * documento). La clase `MemoryRateLimiter` conserva la interfaz del
 * `DocumentRateLimiter` de T2 (tests y compatibilidad).
 */

export interface RateLimitBudget {
  /** Intentos máximos dentro de la ventana. */
  maxAttempts: number;
  /** Ventana deslizante en milisegundos. */
  windowMs: number;
  /** Espacio de nombres para no mezclar login con password-reset. */
  namespace: string;
}

export interface RateLimitOutcome {
  blocked: boolean;
  attempts: number;
}

/**
 * Implementación en memoria (T2, edge-safe y síncrona). Es el fallback
 * cuando Upstash no está configurado y la referencia de compatibilidad
 * para `DocumentRateLimiter` del servicio auth.
 */
export class MemoryRateLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly maxAttempts: number = 5,
    private readonly windowMs: number = 15 * 60 * 1000,
  ) {}

  static normalize(key: string): string {
    return key.trim();
  }

  isBlocked(key: string, nowMs: number): boolean {
    return this.recent(MemoryRateLimiter.normalize(key), nowMs).length >= this.maxAttempts;
  }

  recordFailure(key: string, nowMs: number): { blocked: boolean; attempts: number } {
    const normalized = MemoryRateLimiter.normalize(key);
    const recent = this.recent(normalized, nowMs);
    recent.push(nowMs);
    this.attempts.set(normalized, recent);
    return { blocked: recent.length >= this.maxAttempts, attempts: recent.length };
  }

  reset(key: string): void {
    this.attempts.delete(MemoryRateLimiter.normalize(key));
  }

  private recent(key: string, nowMs: number): number[] {
    const cutoff = nowMs - this.windowMs;
    return (this.attempts.get(key) ?? []).filter((t) => t > cutoff);
  }
}

/** True cuando hay backend externo configurado (Upstash Redis REST). */
export function isExternalRateLimitConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
  );
}

let memoryWarningLogged = false;

function warnMemoryFallback(): void {
  if (memoryWarningLogged) return;
  memoryWarningLogged = true;
  console.warn(
    "[rate-limit] UPSTASH_REDIS_REST_URL/TOKEN no configurados; " +
      "usando memoria local (no válido en serverless multi-instancia).",
  );
}

function redisKey(key: string, budget: RateLimitBudget): string {
  return `orabella:ratelimit:${budget.namespace}:${key.trim()}`;
}

interface UpstashResult {
  result: unknown;
}

/** Llamada mínima al API REST de Upstash. Null ante cualquier fallo. */
async function upstash(path: string, method: "GET" | "POST"): Promise<UpstashResult | null> {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return null;
  try {
    const response = await fetch(`${base.replace(/\/+$/, "")}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    return (await response.json()) as UpstashResult;
  } catch {
    return null;
  }
}

/** Fallback en memoria compartido por el proceso (uno por namespace). */
const memoryFallbacks = new Map<string, MemoryRateLimiter>();

function memoryFor(budget: RateLimitBudget): MemoryRateLimiter {
  let limiter = memoryFallbacks.get(budget.namespace);
  if (!limiter) {
    limiter = new MemoryRateLimiter(budget.maxAttempts, budget.windowMs);
    memoryFallbacks.set(budget.namespace, limiter);
  }
  return limiter;
}

/** ¿El documento está bloqueado? (externo si hay Upstash, si no memoria). */
export async function isRateLimited(key: string, budget: RateLimitBudget): Promise<boolean> {
  if (!isExternalRateLimitConfigured()) {
    warnMemoryFallback();
    return memoryFor(budget).isBlocked(key, Date.now());
  }
  const data = await upstash(`get/${encodeURIComponent(redisKey(key, budget))}`, "GET");
  if (!data) {
    warnMemoryFallback();
    return memoryFor(budget).isBlocked(key, Date.now());
  }
  const count = typeof data.result === "string" ? Number(data.result) : 0;
  return Number.isFinite(count) && count >= budget.maxAttempts;
}

/**
 * Registra un fallo y devuelve si quedó bloqueado. Con Upstash usa
 * INCR + EXPIRE (la ventana la marca el primer fallo); ante fallo del
 * backend degrada a memoria sin romper el login.
 */
export async function recordRateFailure(
  key: string,
  budget: RateLimitBudget,
): Promise<RateLimitOutcome> {
  if (!isExternalRateLimitConfigured()) {
    warnMemoryFallback();
    return memoryFor(budget).recordFailure(key, Date.now());
  }
  const redis = redisKey(key, budget);
  const data = await upstash(`incr/${encodeURIComponent(redis)}`, "POST");
  const count = typeof data?.result === "number" ? data.result : null;
  if (count === null) {
    warnMemoryFallback();
    return memoryFor(budget).recordFailure(key, Date.now());
  }
  if (count === 1) {
    const windowSeconds = Math.max(1, Math.ceil(budget.windowMs / 1000));
    await upstash(`expire/${encodeURIComponent(redis)}/${windowSeconds}`, "POST");
  }
  return { blocked: count >= budget.maxAttempts, attempts: count };
}

/** Limpia el contador (login exitoso). */
export async function resetRateLimit(key: string, budget: RateLimitBudget): Promise<void> {
  memoryFor(budget).reset(key);
  if (!isExternalRateLimitConfigured()) {
    warnMemoryFallback();
    return;
  }
  await upstash(`del/${encodeURIComponent(redisKey(key, budget))}`, "POST");
}
