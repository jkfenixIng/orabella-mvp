# Inventario de copia de usuario que nombra la sede

> **Esperando la decisión del dueño.** Nada de esto se edita todavía: es el inventario de
> vocabulario, y el vocabulario lo decide el dueño. Origen: exploración read-only del
> 2026-10-04 sobre `app/app/**` y `app/src/**`, con la técnica de excluir comentarios,
> identificadores, referencias a columnas y tests. **73 cadenas renderizadas**, clasificadas
> en 10 falsos, 4 a decidir y 59 legítimos.

## Contexto

La instalación es de **una sola sede** por decisión del dueño (M1–M3c): la tabla `sedes`
conserva **una** fila activa que representa a la instalación, `users.sede_id` sobrevive como
ancla de la cuenta (decisión documentada, no deuda) y `current_sede_id()` sigue viva porque una
política la llama. Es decir: la palabra «sede» **nombra algo que existe**, pero ya no un
alcance. El defecto de copia no es la palabra en sí, sino las frases que **afirman un alcance
que se retiró** o una condición que ya no puede darse.

## Falsos (10) — la frase afirma algo que no es

### A. El plural retirado, en dos superficies siempre visibles
- `app/app/page.tsx:58` — `"Estado de la instalación: las sedes y su fecha de inicio de nómina."`
  La tarjeta de `/plataforma` edita **una** fila. → singular.
- `app/src/shared/components/main-nav.tsx:105` — `"Sedes de la instalación y su nómina"`.
  El mismo plural, ahora en la barra lateral. → `"La instalación y su nómina"`.

Es el candidato más fuerte a ser **el mensaje que el dueño vio**: está en dos superficies que
se ven siempre, y afirma el modelo plural en la pantalla que existe para configurar la
instalación única.

### B. La unicidad global contada como si fuera por sede
- `app/src/features/inventory/service.ts:187` y `:211` — `"El SKU ya existe en esta sede."`
  La consulta de conflicto filtra **solo por `sku`**: la unicidad es global. El texto enseña
  una regla que el sistema no aplica. → `"El SKU ya existe."`
- `app/app/inventory/inventory-client.tsx:499` — `"Código único por sede (p. ej. SH-001 para shampoo)."`
- `app/src/features/admin/service.ts:313`, `:412`, `:436` — `"El código de empleado ya existe en esta sede."`
  Mismo caso: el índice de unicidad ya no lleva la sede. Es el **único del grupo que se dispara
  en un guardado real**, o sea que el dueño puede chocarlo operando.
- `app/app/admin/admin-sections/employees-section.tsx:436` — `"Código interno (opcional, único por sede)"`.

### C. El permiso contado como si fuera una frontera de sede
- `app/src/features/cash/service.ts:129` — `"No tiene acceso a esa sede."`
  El `FORBIDDEN` de facturación ya no viene de una frontera de sede: viene de la guarda de rol.
  → `"No tiene permiso para esta acción."`

## A decidir (4) — la palabra designa a la instalación

- `app/app/admin/admin-sections/users-section.tsx:126` — `" · sin sede"`. El estado existe
  (`users.sede_id` es nulable), pero la palabra sugiere sucursales. ¿Se deja, o pasa a
  `"· sin instalación"`?
- `app/src/features/auth/schemas.ts:108` — `"Sede inválida."`. Valida un `sede_id` que el
  servidor ya ignora; **probablemente copia muerta** (hay que confirmar que no la renderiza
  ningún formulario).
- `app/src/features/cash/service.ts:305` — `"Denominación no configurada para esta sede."`
- `app/src/features/payroll/schemas.ts:2288` — `` `${args.total} ${noun} en la sede.` ``

## Legítimos (59) — la condición sigue existiendo

- **`"El usuario no tiene sede asignada."`** — se renderiza en ocho páginas
  (`alerts`, `admin`, `vales`, `invoices`, `services`, `inventory`, `cash`, `payroll`) y se
  lanza desde siete servicios. La condición es real: la cuenta sin `sede_id` no opera.
- **Descripciones de página «…de su sede»** y vacíos «Aún no hay … en esta sede».
- **Títulos de tarjeta**: `"Servicios de la sede"`, `"Facturas de la sede"`.
- **`El método de pago ${code} no está activo en esta sede.`** — en 9 sitios de 5 módulos.
  Los métodos de pago se leen a través de la fila de la sede.
- **404 «…no encontrado en esta sede.»** y los mensajes de período de nómina.
- **Copia de plataforma ya consciente del mono-sede** (`platform/service.ts:198`, `:205`;
  `app/plataforma/page.tsx:69-71`, `:76`).

## Orden de arreglo sugerido

1. **El plural (A)**: dos palabras, dos superficies siempre visibles, y es lo que el dueño
   probablemente vio.
2. **El SKU (B-inventario)**: la copia contradice el código que corre.
3. **El código de empleado (B-admin)**: la misma contradicción, y esta sí salta en un guardado.

## Decisión del dueño (2026-10-04)

**El vocabulario es «instalación» y el barrido va completo**, no solo sobre los falsos: *«no hay
sedes así que hay que modificar si dice algo relevante o real»*. Las 73 cadenas se revisan.

La regla que se aplica a cada una, en este orden:

1. **Si la frase afirma un alcance que se retiró, se reescribe** —no se le cambia la palabra—:
   la unicidad del SKU y del código de empleado es global, y el 403 de caja viene del rol.
2. **Si nombra a la instalación, dice «instalación»**: «Servicios de la instalación», «no
   encontrado en la instalación», «no está activo en la instalación».
3. **Si la condición existe de verdad, se conserva la condición y cambia la palabra**:
   `users.sede_id` es el ancla de la cuenta, así que «El usuario no tiene sede asignada» pasa a
   «El usuario no tiene instalación asignada» — la guarda no se toca, el vocabulario sí.

## Tasks

- [ ] **U16** — Las 59 cadenas legítimas, encadenadas por módulo (facturas, vales, caja, admin,
      servicios, alertas, inventario). Corre **después** de `fecha-arranque-automatica.md`, que es
      dueña de los mensajes de nómina y de la retirada de `/plataforma`: acá no se toca ninguno de
      los dos.
- [ ] **U17** — Gate completo (suite, typecheck, eslint) y commits por unidad.

## Incertidumbre declarada

El alcance de los métodos de pago y de los mensajes de período se verificó leyendo los
comentarios de contrato del código, no las migraciones (quedaban fuera de las rutas
permitidas de la exploración). Los 59 «legítimos» heredan esa incertidumbre.
