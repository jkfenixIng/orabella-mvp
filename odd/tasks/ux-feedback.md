# Feedback de UI: `Alert` para estado y toast para eventos

## Objective
Reemplazar el feedback ad-hoc como texto inline por componentes del sistema: un `Alert` inline para mensajes de ESTADO y un toast (primitivo de shadcn) para EVENTOS. Mejorar la UX de los mensajes sin romper las suites e2e que dependen de `role="status"`.

## Problem
- **54 ocurrencias** de `role="status"` / `role="alert"` en 30 archivos. Desglose: 7 en `*/loading.tsx` (esqueletos, uso correcto — **no se tocan**), 8 en `*/page.tsx` (errores del server), **39 en componentes client = el problema**.
- **No existe ningún mecanismo de toast en el proyecto.** Cero. Todo el feedback es un `<p role="status">` persistente.
- **El defecto de fondo no es el color, es que se confunden estado y evento.** "Turno abierto" es un EVENTO y se renderiza como ESTADO, así que queda pegado en pantalla para siempre y compite visualmente con los avisos que sí cambian. Ese es el síntoma que se siente mal.
- `role="status"` (región cortés) y `role="alert"` (región asertiva, interrumpe) se usan intercambiados: algunos errores susurran y algunos éxitos gritan.
- Sin componente canónico, cada pantalla inventó su spelling (`bg-warning-light`, `bg-amber-50`, `errorClass`, …).

## Why
Pedido explícito del usuario: "hay textos que usa como alertas de exitoso error warnings y etc en vez de componentes que se usan regularmente para eso, hay que mejorar la ux en general". Un "✓ turno abierto" que nunca desaparece es el síntoma más visible.

## Decisiones tomadas por el usuario (2026-10-01)
- **Toast sí, y con shadcn.** El primitivo de toast de shadcn es `sonner`, o sea **una dependencia npm nueva** (MIT, chica). Autorizada.
- **"Hay que poder usar lo que se tiene"** → el trabajo del choque de nombres va primero, para poder ampliar los 10 primitivos existentes con componentes del registry.
- Flujo aceptado: A → B → C. Prioridad: choque de nombres primero, después A y B.

## Diseño
| Necesidad | Componente | Rol ARIA |
| --- | --- | --- |
| Estado contextual ("supera el tope", "no hay turno abierto") | `Alert` inline, persistente, junto a lo que describe | `status` para info/éxito de estado, `alert` solo para error que interrumpe |
| Evento ("turno abierto", "vale aprobado") | Toast, transitorio, se va solo | `status` |

Clave: **el éxito de un evento deja de persistir**. Hoy no se puede, porque no hay toast.

## Scope
### WU-A — Primitivos, sin migración
- `app/src/components/ui/lib/alert.tsx` (nuevo; variantes success/warning/destructive/info sobre el vocabulario del proyecto, igual que los otros 10 primitivos)
- `app/src/components/ui/lib/sonner.tsx` + `<Toaster />` montado en el layout
- `package.json` + lockfile: `sonner`
- Test de contrato offline nuevo
- **Condición de fin**: existe el componente y el toast, con test. Cero migración.

### WU-B — Un módulo como patrón de referencia
- Módulo a elegir **sin acoplamiento e2e** (caja queda excluida, ver abajo)
- **Condición de fin**: ese módulo sin `role` ad-hoc; cada mensaje es state o event, y ninguno queda pegado en pantalla

### WU-C — Migración del resto, un commit por módulo
- 39 sitios, más los specs e2e que dependan de ellos, actualizados **a propósito** en el mismo commit

## Restricción de pruebas (medida, no supuesta)
9 specs e2e: `api`, `auth.setup`, `authed`, `cash`, `guards`, `invoices`, `login`, `notfound`, `smoke`.
`tests/e2e/cash.spec.ts` afirma **4 veces** sobre `p[role="status"]` con texto:

```ts
await expect(page.locator('p[role="status"]', { hasText: /turno abierto/i })).toBeVisible()
```

Consecuencias que se respetan:
1. **Caja NO puede ser el módulo de referencia.**
2. Toda migración preserva `role` y el texto, **o** actualiza el spec a propósito en el mismo commit. Nunca romperlo por efecto colateral.

## Tasks
- [ ] WU-A primitivos `Alert` + toast (`sonner`)
- [ ] WU-B módulo de referencia, sin acoplamiento e2e
- [ ] WU-C migración por módulos, con los specs que correspondan

## Estado
- 2026-10-01: creado. Autorizado por el usuario. Espera turno de escritura (single-threaded: hay una verificación corriendo sobre el árbol).
