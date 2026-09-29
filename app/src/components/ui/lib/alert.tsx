import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { CircleCheck, Info, OctagonX, TriangleAlert } from 'lucide-react'

import { cn } from './utils'

/* --------------------------------------------------------------------------
   Alert — mensaje contextual INLINE y PERSISTENTE: lo que se renderiza al lado
   de un formulario o de un panel cuando algo *es* el caso ("no hay turno
   abierto", "el vale supera el tope", "no se pudo guardar"). Lo efímero que
   aparece y se va solo es el toast de sonner.tsx, no este componente.

   Los colores salen del vocabulario de tokens del PROYECTO, no del texto del
   registry: `bg-*-light` + `text-*` son las parejas que design-tokens.css
   declara (y con las que ya están escritos a mano los avisos actuales). En
   claro el fondo es el peldaño -50 y el texto el -600; `.dark` invierte ambos
   con sus propios overrides, que también viven en design-tokens.css.

   Sin `'use client'`: no usa hooks, estado ni handlers, así que el mismo
   archivo sirve desde un Server Component y desde un Client Component. Quien
   pase un handler ya está, por definición, en un módulo cliente.
   -------------------------------------------------------------------------- */

export type AlertVariant = 'success' | 'warning' | 'destructive' | 'info'
export type AlertRole = 'status' | 'alert'

const alertVariants = cva(
  'flex w-full items-start gap-3 rounded-md border p-4 text-sm',
  {
    variants: {
      variant: {
        success: 'border-transparent bg-success-light text-success',
        warning: 'border-transparent bg-warning-light text-warning',
        destructive: 'border-transparent bg-error-light text-error',
        // "info" no es una novedad ni un problema: usa el tinte de marca, el
        // mismo par que la variante default de badge.tsx.
        info: 'border-transparent bg-primary-light text-primary-color',
      },
    },
    defaultVariants: {
      variant: 'info',
    },
  },
)

export const DEFAULT_ALERT_VARIANT: AlertVariant = 'info'

/**
 * Rol ARIA por variante. La decisión NO es cosmética:
 *
 * - `status` (aria-live=polite) avisa cuando el lector termine lo que está
 *   leyendo. Es lo correcto para confirmaciones y datos: success e info no
 *   necesitan interrumpir a nadie.
 * - `alert` (aria-live=assertive) interrumpe. Solo se justifica cuando el
 *   mensaje describe algo que el usuario tiene que atender ya: warning y
 *   destructive.
 *
 * Un `role="status"` global para las cuatro variantes dejaría los errores
 * mudos hasta que el foco vuelva; un `role="alert"` global gritaría cada
 * "guardado".
 */
export const ALERT_ROLE_BY_VARIANT: Record<AlertVariant, AlertRole> = {
  success: 'status',
  info: 'status',
  warning: 'alert',
  destructive: 'alert',
}

/**
 * Rol efectivo de un `Alert`. El explícito gana; sin explícito, se deriva de la
 * variante. Función pura a propósito: así la política de accesibilidad se
 * puede afirmar en un test sin DOM.
 */
export function alertRole(
  variant: AlertVariant | null | undefined,
  role?: AlertRole | null,
): AlertRole {
  if (role) {
    return role
  }
  return ALERT_ROLE_BY_VARIANT[variant ?? DEFAULT_ALERT_VARIANT]
}

/**
 * Icono por defecto de cada variante. No es adorno: sin él, la única diferencia
 * entre "guardado" y "no se pudo guardar" sería el color, y el color por sí
 * solo no alcanza (WCAG 1.4.1). `icon={null}` los desactiva.
 */
const DEFAULT_ALERT_ICON: Record<AlertVariant, React.ComponentType> = {
  success: CircleCheck,
  info: Info,
  warning: TriangleAlert,
  destructive: OctagonX,
}

/**
 * `title` sale del `Omit` porque colisiona con el atributo HTML homónimo (el
 * tooltip nativo): en un componente de feedback el título es VISIBLE, no un
 * tooltip, así que la prop se reescribe como nodo de React.
 */
export type AlertProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'title'
> &
  VariantProps<typeof alertVariants> & {
    /** Título corto, en negrita, sobre el cuerpo. */
    title?: React.ReactNode
    /**
     * Icono (lucide). Sin pasar nada se usa el de la variante; `null` no dibuja
     * ninguno.
     */
    icon?: React.ReactNode
    /**
     * Rol ARIA explícito. Por defecto se deriva de la variante
     * (success/info → polite, warning/destructive → assertive). Pasalo solo
     * para cambiar esa decisión: por ejemplo `role="status"` en un error que
     * NO es urgente, o `role="alert"` en un info que sí lo es.
     */
    role?: AlertRole
  }

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, title, icon, role, children, ...props }, ref) => {
    const resolvedVariant = variant ?? DEFAULT_ALERT_VARIANT
    const DefaultIcon = DEFAULT_ALERT_ICON[resolvedVariant]
    const resolvedIcon = icon === undefined ? <DefaultIcon /> : icon

    return (
      <div
        ref={ref}
        role={alertRole(resolvedVariant, role)}
        className={cn(alertVariants({ variant: resolvedVariant }), className)}
        {...props}
      >
        {resolvedIcon === null || resolvedIcon === undefined ? null : (
          // aria-hidden: el icono repite lo que ya dice el texto. Anunciarlo
          // como gráfico sin nombre accesible solo ensucia la lectura.
          // El tamaño se aplica al hijo (`[&>svg]`) para no meter clases de
          // tamaño en el icono que trae el consumidor.
          <span
            aria-hidden="true"
            className="mt-0.5 shrink-0 [&>svg]:size-4 [&>svg]:shrink-0"
          >
            {resolvedIcon}
          </span>
        )}
        <div className="flex min-w-0 flex-col gap-1">
          {title === null || title === undefined ? null : (
            // <p> y no <h5>: un aviso inline no es un encabezado del documento,
            // y un nivel de heading suelto desorienta al lector de pantalla.
            <p className="font-semibold leading-tight">{title}</p>
          )}
          {children === null || children === undefined ? null : (
            <div className="min-w-0">{children}</div>
          )}
        </div>
      </div>
    )
  },
)
Alert.displayName = 'Alert'

export { Alert, alertVariants }
