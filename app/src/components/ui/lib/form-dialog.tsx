'use client'

import * as React from 'react'

import { Alert } from './alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog'
import { cn } from './utils'
import { buttonClass, ghostClass } from '@/src/shared/lib/ui-styles'

/* --------------------------------------------------------------------------
   FormDialog / ConfirmDialog — los dos modales que el árbol escribía a mano,
   cada vez distinto.

   El defecto que cierran es doble y ya ocurrió:

   1. Diálogos sin nombre accesible. `app/invoices/invoices-client.tsx` tiene 6
      `DialogContent` y 0 `DialogTitle`. Radix toma el nombre accesible del
      `DialogTitle`: esos 6 modales se anuncian sin nombre. No fue descuido de
      una tarde, fue el resultado previsible de que armar el título sea
      OPCIONAL para el llamador. Acá `title` es obligatorio y el primitivo lo
      renderiza él mismo, así que el olvido deja de ser posible.
   2. La misma acción construida de dos maneras en el mismo panel. Crear/editar
      es un diálogo en `employees-section.tsx`, `users-section.tsx` y
      `vales-section.tsx`, y un formulario pegado debajo de la lista en
      `taxes-section.tsx`, `methods-section.tsx` y `cash-section.tsx`. Cada uno
      de esos formularios inline repite a mano el mismo cableado
      submit/busy/error/cancelar. La duplicación no es del markup: es de la
      DECISIÓN de qué pasa al enviar, y por eso ya divergió.

   `children` son SOLO los campos. El `<form>`, el encabezado, el error y el
   pie son del primitivo; si el llamador tuviera que armar el `<form>` volvería
   a decidir por su cuenta cuándo bloquear el envío.

   Sobre el vocabulario: las primitivas hermanas suelen declarar sus propias
   clases en vez de leer `ui-styles.ts`. Acá es al revés, y a propósito: el botón
   de un `FormDialog` tiene que ser EL MISMO que el de la sección que lo abre, y
   ese ya está congelado en `buttonClass` / `ghostClass`. Una segunda definición
   de «botón primario» es la deriva que este primitivo viene a eliminar. Es el
   mismo criterio con el que `data-table.tsx` deja las celdas en
   `tableHeaderClass` / `tableRowClass` de `ui-styles.ts`.

   `'use client'`: hay handlers (`onSubmit`, `onOpenChange`, `onConfirm`), o sea
   hooks y eventos. No es una primitiva que pueda servir desde un Server
   Component.
   -------------------------------------------------------------------------- */

export type FormDialogSize = 'md' | 'lg' | 'xl'

/**
 * Ancho por tamaño. El valor no es cosmético: un formulario de una columna se
 * llena bien en `md`, y uno de dos columnas —los que hoy escriben
 * `sm:grid-cols-2`— necesita `lg` o `xl` o las etiquetas se parten al medio.
 *
 * El mapa vive acá para que el llamador ELIJA un tamaño del vocabulario en vez
 * de inventar su `max-w-*` por archivo, que es exactamente cómo aparecieron los
 * tres anchos sin criterio de `invoices-client.tsx`.
 */
const FORM_DIALOG_SIZE_CLASS: Record<FormDialogSize, string> = {
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
}

/**
 * Botón de confirmación destructiva.
 *
 * `ui-styles.ts` NO tiene clase de peligro y no se le agrega una: el único lugar
 * donde hace falta es la confirmación de algo irreversible, o sea acá. Un token
 * nuevo en el estándar compartido para un solo consumidor es vocabulario de más.
 *
 * `bg-error text-white` son tokens del proyecto (`--color-error`, y `text-white`
 * es el frente plano que `buttonClass` ya usa sobre rellenos sólidos).
 *
 * El hover NO puede ser `hover:bg-error-700`: `globals.css` no expone ese
 * peldaño en su `@theme inline`, así que una clase así no generaría nada y el
 * botón quedaría sin respuesta al mouse. Se atenúa con `hover:opacity-90`.
 *
 * `hover:bg-error` no es adorno: `buttonClass` trae `hover:bg-primary-700`, y
 * `tailwind-merge` solo descarta una clase cuando la nueva cae en el MISMO
 * grupo. Sin repetir el fondo en el hover, el botón destructivo se pintaría de
 * azul de marca justo cuando el usuario va a confirmar la baja.
 */
const DESTRUCTIVE_BUTTON_CLASS = cn(
  buttonClass,
  'bg-error text-white hover:bg-error hover:opacity-90',
)

/**
 * Opt-out explícito de `aria-describedby`.
 *
 * Radix construye el atributo del contenido así:
 * `aria-describedby={descriptionPresent ? descriptionId : undefined}`. Cuando el
 * diálogo no lleva descripción, el atributo no se emite y el lector solo
 * anuncia el nombre. El problema histórico es que las versiones de Radix que
 * emiten el aviso «Missing `Description` or `aria-describedby={undefined}`»
 * exigen que la AUSENCIA sea una decisión declarada y no un olvido.
 *
 * Verificado en el `node_modules` de este repo
 * (`@radix-ui/react-dialog@1.1.23`, `dist/index.js` e `index.mjs`): esa versión
 * NO trae ningún `console.*`, o sea que hoy no avisa nada; su contenido ya
 * resuelve el atributo de la forma de arriba. La prop queda igual porque es la
 * parte del contrato de Radix que sobrevive a un upgrade, y porque el `...spread`
 * de `contentProps` va DESPUÉS del atributo calculado: pasarla cuando no hay
 * descripción es una no-op deliberada, y pasarla siempre rompería el vínculo
 * cuando la descripción SÍ existe. Por eso solo se aplica en la rama sin
 * descripción.
 */
const NO_DESCRIPTION_ATTR = { 'aria-describedby': undefined } as const

export type FormDialogProps = {
  /** Estado controlado, igual que en `Dialog`. */
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Obligatorio y de tipo `string`: es el nombre accesible del diálogo. Si
   * aceptara `ReactNode`, el llamador podría pasar un componente que no
   * renderiza texto y el título volvería a ser decorativo.
   */
  title: string
  /** Línea de contexto. Opcional: no todo formulario necesita explicarse. */
  description?: React.ReactNode
  /**
   * Se llama con el evento de un `<form>` real. La primitiva ya hizo
   * `preventDefault()`, así que el llamador solo se ocupa de su lógica.
   */
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  /** Envío en curso: bloquea el botón y cambia su etiqueta. */
  busy?: boolean
  /** Texto del botón de envío en reposo ("Crear empleado", "Guardar cambios"). */
  submitLabel: string
  /** Texto del botón mientras `busy`. Se dice QUÉ está pasando, no un `disabled` mudo. */
  busyLabel?: string
  cancelLabel?: string
  /**
   * Error del último intento. Es estado, no un aviso: se queda a la vista
   * dentro del diálogo hasta el próximo envío, por eso es un `Alert` y no un
   * toast.
   */
  error?: string | null
  size?: FormDialogSize
  /** Los CAMPOS, y nada más: el formulario y el pie los pone el primitivo. */
  children: React.ReactNode
}

/**
 * Diálogo de alta y edición. Envuelve `Dialog`, declara el título y cablea el
 * ciclo submit/busy/error/cancelar una sola vez.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  onSubmit,
  busy = false,
  submitLabel,
  busyLabel = 'Guardando…',
  cancelLabel = 'Cancelar',
  error,
  size = 'lg',
  children,
}: FormDialogProps) {
  const hasDescription = description !== undefined && description !== null

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    // El submit nativo recarga la página y se lleva el diálogo puesto: el
    // usuario pierde lo cargado y no ve llegar el error. Cortarlo acá —y no en
    // cada llamador— es la mitad de la maquinaria que hoy está copiada en cada
    // sección, con el riesgo de que la copia 7 se olvide.
    event.preventDefault()
    onSubmit(event)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={FORM_DIALOG_SIZE_CLASS[size]}
        {...(hasDescription ? {} : NO_DESCRIPTION_ATTR)}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {hasDescription ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form onSubmit={handleSubmit} className="mt-3">
          {children}
          {error ? (
            <Alert variant="destructive" className="mt-3">
              {error}
            </Alert>
          ) : null}
          <DialogFooter className="mt-4">
            {/*
              Cancelar cierra sin tocar el envío: es la salida del usuario. No se
              deshabilita con `busy` porque un botón que no responde es peor que
              un cierre a destiempo, y el llamador ya cubre ese caso apagando la
              escritura que quedó en vuelo.
            */}
            <button type="button" className={ghostClass} onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </button>
            <button type="submit" className={buttonClass} disabled={busy}>
              {busy ? busyLabel : submitLabel}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export type ConfirmDialogVariant = 'destructive' | 'default'

export type ConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Obligatorio: mismo motivo que en `FormDialog`. */
  title: string
  /**
   * Obligatorio y OBLIGATORIAMENTE concreto. El cuerpo explica QUÉ SE PIERDE
   * («se borran los 3 turnos abiertos de la sede Norte»), no repite la pregunta
   * del título. Un «¿Estás seguro?» no le da al usuario nada con que decidir: si
   * supiera la respuesta, no estaría confirmando.
   */
  description: React.ReactNode
  confirmLabel?: string
  /** Se dice QUÉ está pasando ("Procesando…", "Eliminando…"). */
  busyLabel?: string
  onConfirm: () => void
  busy?: boolean
  /** `destructive` para lo que no se deshace; `default` para lo que sí. */
  variant?: ConfirmDialogVariant
}

/**
 * Confirmación de una acción destructiva o irreversible. No es un `ConfirmDialog`
 * para preguntar cosas: para eso alcanza el propio flujo.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirmar',
  busyLabel = 'Procesando…',
  onConfirm,
  busy = false,
  variant = 'destructive',
}: ConfirmDialogProps) {
  const confirmClass = variant === 'destructive' ? DESTRUCTIVE_BUTTON_CLASS : buttonClass

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {/* Obligatoria, así que acá no hace falta el opt-out: Radix arma el
              `aria-describedby` solo, y el cuerpo es lo que el lector anuncia
              además del título. */}
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-4">
          <button type="button" className={ghostClass} onClick={() => onOpenChange(false)}>
            Cancelar
          </button>
          <button
            type="button"
            className={confirmClass}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
