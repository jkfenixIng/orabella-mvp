'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Slot } from '@radix-ui/react-slot'
import { cn } from './utils'

type DialogProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>

type DialogOverlayProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>

type DialogHeaderProps = React.HTMLAttributes<HTMLDivElement>

type DialogFooterProps = React.HTMLAttributes<HTMLDivElement>

type DialogTitleProps = React.HTMLAttributes<HTMLHeadingElement>

type DialogDescriptionProps = React.HTMLAttributes<HTMLParagraphElement>

// El estado `open` vive en el Root de Radix y no se expone a los hijos. Como el
// componente `DialogContent` permanece montado aunque el diálogo esté cerrado
// (Radix solo desmonta el portal, no el componente React), hace falta un
// contexto propio para que `DialogContent` sepa si el diálogo está abierto.
const DialogOpenContext = React.createContext(false)

/**
 * Root del diálogo. Envuelve a `DialogPrimitive.Root` para publicar el estado
 * abierto/cerrado a `DialogContent`. Mantiene el comportamiento controlado y no
 * controlado (`open`/`defaultOpen`/`onOpenChange`).
 */
const Dialog = ({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: DialogProps) => {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const isControlled = openProp !== undefined
  const open = isControlled ? openProp : uncontrolledOpen

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [isControlled, onOpenChange],
  )

  return (
    <DialogOpenContext.Provider value={open}>
      <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange} {...props} />
    </DialogOpenContext.Provider>
  )
}
Dialog.displayName = DialogPrimitive.Root.displayName

type DialogTriggerProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger> & {
  asChild?: boolean
}

/**
 * Disparador de apertura.
 *
 * Renderiza `DialogPrimitive.Trigger` y NO un `Slot` pelado. Antes renderizaba
 * `Slot` o un `<button>` y nada más: se declaraba del tipo
 * `DialogPrimitive.Trigger`, pero no ERA uno, así que no se conectaba al
 * contexto de Radix. Lo que se pierde al no serlo no es cosmético:
 *
 *   - `onClick` no alternaba el diálogo, porque el alternado vive en Radix;
 *   - `triggerRef` quedaba vacío, y `DialogContent` (modal) hace
 *     `onCloseAutoFocus: preventDefault()` y después
 *     `triggerRef.current?.focus()`. Sin disparador, ese `?.` no enfoca NADA y
 *     el `preventDefault()` le impide a `FocusScope` su propio rescate: el foco
 *     se perdía en el `BODY` al cerrar.
 *   - tampoco emitía `aria-haspopup="dialog"` ni `aria-expanded`.
 *
 * Esa última línea es el R2 medido del cajón móvil («al cerrar el foco queda en
 * el cuerpo»). El tipo y el `asChild` no cambian: la firma pública queda igual.
 */
const DialogTrigger = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Trigger>,
  DialogTriggerProps
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex h-10 items-center justify-center rounded-md border border-border-color bg-surface px-4 py-2 text-sm font-medium text-text-primary shadow-sm transition-all duration-200 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 dark:border-border-color-2 dark:text-text-primary dark:hover:bg-surface-hover dark:focus-visible:ring-primary-400 dark:focus-visible:ring-offset-2',
      className,
    )}
    {...props}
  >
    {children}
  </DialogPrimitive.Trigger>
))
DialogTrigger.displayName = DialogPrimitive.Trigger.displayName

type DialogCloseProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close> & {
  asChild?: boolean
}

const DialogClose = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  DialogCloseProps
>(({ className, children, type, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      ref={ref}
      type={type ?? 'button'}
      className={cn(
        'inline-flex h-10 items-center justify-center rounded-md border border-border-color bg-surface px-4 py-2 text-sm font-medium text-text-primary shadow-sm transition-all duration-200 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 dark:border-border-color-2 dark:text-text-primary dark:hover:bg-surface-hover dark:focus-visible:ring-primary-400 dark:focus-visible:ring-offset-2',
        className,
      )}
      {...props}
    >
      {children}
    </Comp>
  )
})
DialogClose.displayName = DialogPrimitive.Close.displayName

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  DialogOverlayProps
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
        'fixed inset-0 z-40 bg-black/60 transition-opacity duration-150 data-[state=open]:opacity-100 data-[state=closed]:opacity-0',
      className,
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

// U1: apilado de diálogos. Radix no ordena modal-sobre-modal: con z-index fijo
// el overlay del nuevo diálogo queda DEBAJO del contenido del anterior, así que
// el modal de abajo no se atenúa ni se desenfoca. Cada diálogo ABIERTO toma un
// nivel y su overlay siempre queda por encima del contenido anterior.
//
// El registro cuenta SOLO diálogos abiertos, no montados: `DialogContent`
// permanece montado mientras el diálogo está cerrado (Radix solo desmonta el
// portal), así que contar montajes inflaba el nivel y dejaba los popovers
// compartidos (`Select`, `Combobox`, z-index fijo) por debajo del overlay del
// propio modal, volviéndolos invisibles e icliqueables.
const openDialogTokens: object[] = []

const layerSubscribers = new Set<() => void>()

function notifyLayerChange() {
  for (const notify of layerSubscribers) notify()
}

function subscribeLayers(notify: () => void): () => void {
  layerSubscribers.add(notify)
  return () => {
    layerSubscribers.delete(notify)
  }
}

function getOpenDialogCount(): number {
  return openDialogTokens.length
}

/** Cantidad de diálogos abiertos ahora mismo; reactivo a los cambios de la pila. */
function useOpenDialogCount(): number {
  return React.useSyncExternalStore(subscribeLayers, getOpenDialogCount, () => 0)
}

/**
 * Registra el diálogo en la pila mientras está abierto y devuelve su nivel
 * (1 = el más bajo). Devuelve 0 cuando el diálogo está cerrado.
 */
function useDialogLayer(open: boolean): number {
  const tokenRef = React.useRef<object | null>(null)
  const openCount = useOpenDialogCount()

  React.useLayoutEffect(() => {
    if (!open) return
    const token = {}
    tokenRef.current = token
    openDialogTokens.push(token)
    notifyLayerChange()
    return () => {
      const at = openDialogTokens.indexOf(token)
      if (at >= 0) openDialogTokens.splice(at, 1)
      tokenRef.current = null
      notifyLayerChange()
    }
  }, [open])

  const token = tokenRef.current
  if (token === null || openCount === 0) return 0
  const rank = openDialogTokens.indexOf(token)
  return rank >= 0 ? rank + 1 : 0
}

const DIALOG_OVERLAY_BASE = 45
const DIALOG_CONTENT_BASE = 50
const DIALOG_LAYER_STEP = 10
// Los popovers deben superar el contenido de su diálogo sin alcanzar el overlay
// del diálogo siguiente de la pila (que queda 5 por encima del contenido).
const POPOVER_OFFSET = 3

/** z-index del overlay y del contenido para un nivel de apilado (>= 1). */
function computeDialogZIndex(level: number): { overlay: number; content: number } {
  const safeLevel = Math.max(1, Math.floor(level))
  const offset = (safeLevel - 1) * DIALOG_LAYER_STEP
  return {
    overlay: DIALOG_OVERLAY_BASE + offset,
    content: DIALOG_CONTENT_BASE + offset,
  }
}

/**
 * z-index que deben usar los popovers (`Select`, `Combobox`) para quedar por
 * encima del contenido del diálogo abierto más alto.
 */
function computePopoverZIndex(openDialogCount: number): number {
  return computeDialogZIndex(Math.max(1, openDialogCount)).content + POPOVER_OFFSET
}

/** z-index reactivo para popovers según la cantidad de diálogos abiertos. */
function usePopoverLayer(): number {
  return computePopoverZIndex(useOpenDialogCount())
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, ...props }, ref) => {
  const open = React.useContext(DialogOpenContext)
  const level = Math.max(1, useDialogLayer(open))
  const { overlay: overlayZ, content: contentZ } = computeDialogZIndex(level)
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        style={{ zIndex: overlayZ }}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-150 data-[state=open]:opacity-100 data-[state=closed]:opacity-0"
      />
      <DialogPrimitive.Content
        ref={ref}
        style={{ zIndex: contentZ, ...props.style }}
        // R7: el diálogoRespira. Antes era `w-full … p-6`, y medido a
        // 320/360/390 el rect daba `left=0, right=viewport`: GUTTER 0 en los
        // dos lados, con una caja de contenido de `ancho−48` (272 px a 320).
        // Un borde pegado al borde no se lee como diálogo: se lee como la
        // página. Abajo de `sm` el padding baja a `p-4` porque hay menos ancho
        // para él; desde `sm` vuelve a `p-6`.
        //
        // `w-[calc(100%-2rem)]` TODAS las anchuras, no solo abajo de `sm`. MEDIDO
        // a 1024 con `sm:w-full` a secas: el diálogo de emisión (`max-w-5xl` =
        // exactamente 1024 px) daba `width=1024`, `left=0`, `right=1024` y
        // GUTTER 0/0 — el mismo defecto de R7, un breakpoint más arriba. Y a
        // 1440 el MISMO diálogo mide 1024 con gutter 208/208: no es una hoja
        // que deba ser de sangre completa, es un `max-w` que a 1024 coincide con
        // el viewport y se come el gutter.
        //
        // POR QUÉ NO SE ARREGLA CON `sm:max-w-[calc(100%-2rem)]`, que parece lo
        // obvio: `max-width` es UNA PROPIEDAD, y la variante de `sm:` llega
        // después en la cascada, así que PISA al `max-w-5xl` del llamador en vez
        // de cruzarse con él. MEDIDO: con ese token el diálogo de emisión mide
        // 1408 px a 1440 con gutter 16 — la factura se estiraba a lo ancho de
        // toda la pantalla para tapar un marco de 24 px que ya no existía. Arreglar
        // R7 así cambia el ancho de un documento: no es un arreglo, es otro
        // defecto. Sin `sm:w-full`, `width` y `max-width` son propiedades
        // DISTINTAS y el navegador toma la menor: `min(ancho−2rem, max-w)`, que
        // deja 1 rem de gutter donde el `max-w` no manda y NO lo toca donde sí
        // manda (1440 → 1024, igual que antes).
        //
        // `100dvh` y no `100vh`: `vh` mide el viewport con la barra de
        // direcciones DESPLEGADA, así que en un teléfono real el borde
        // inferior del diálogo queda debajo de la barra y el último campo
        // (el que la auditoría no alcanzó a medir porque en Chromium headless
        // `100vh == 100dvh == innerHeight` en los cuatro anchos) es el que
        // primero se pierde. Es la misma regla que ya aplica
        // `src/components/ui/lib/page.tsx:56` (`min-h-dvh`) y lo afirma
        // `tests/ux-structure.test.ts`: el cambio NO es medible acá, es
        // correcto por la regla.
        className={cn(
          'fixed left-1/2 top-1/2 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg border border-border-color bg-surface p-4 shadow-xl outline-none transition duration-150 data-[state=open]:scale-100 data-[state=open]:opacity-100 data-[state=closed]:scale-95 data-[state=closed]:opacity-0 sm:p-6 dark:border-border-color-2 dark:bg-surface',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = React.forwardRef<
  HTMLDivElement,
  DialogHeaderProps
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex flex-col gap-1.5 text-left', className)}
    {...props}
  />
))
DialogHeader.displayName = 'DialogHeader'

const DialogFooter = React.forwardRef<
  HTMLDivElement,
  DialogFooterProps
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex flex-col-reverse items-center gap-2 sm:flex-row sm:justify-end', className)}
    {...props}
  />
))
DialogFooter.displayName = 'DialogFooter'

/**
 * El TÍTULO del diálogo: `DialogPrimitive.Title`, no un `<h2>` pelado.
 *
 * MEDIDO antes de este cambio (Chromium, nombre accesible calculado por el
 * motor): `""` en los siete diálogos abiertos — el cajón móvil, facturación
 * (facturar, detalle, editar, agregar ítem), «Nuevo empleado» y «Solicitar
 * vale» — con `aria-labelledby=null` y `aria-label=null`, y con el texto
 * CORRECTO a la vista adentro. Siete de siete.
 *
 * La causa era una línea: este componente se declaraba del tipo
 * `React.ElementRef<typeof DialogPrimitive.Title>` y hasta le ponía el
 * `displayName` de Radix, pero RENDERIZABA un `<h2>` sin `id`. Radix no puede
 * ver un `<h2>`: el nombre accesible no se arma por tener un encabezado, sino
 * porque el título se REGISTRE en el contexto y exista el `titleId` que
 * `DialogPrimitive.Content` pone en su `aria-labelledby`. Sin registro, el
 * contenido del diálogo queda sin nombre.
 *
 * Y no por falta de `<DialogTitle>` en los llamadores: hay 29, uno por cada
 * `DialogContent`, en 10 archivos. El texto estaba; el MECANISMO no. Por eso el
 * arreglo es acá y no un `aria-label` por pantalla: 29 pantallas que se pueden
 * olvidar, contra una primitiva.
 *
 * `DialogPrimitive.Title` renderiza un `<h2>` (`Primitive.h2`) con las mismas
 * clases, así que esto no cambia ni un píxel de lo que se ve.
 */
const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  DialogTitleProps
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      'text-lg font-semibold leading-none tracking-tight text-text-primary',
      className,
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

/**
 * La DESCRIPCIÓN del diálogo: `DialogPrimitive.Description`, no un `<p>` pelado.
 *
 * Mismo defecto, un peldaño más abajo: sin registro no existe el
 * `descriptionId`, y `DialogPrimitive.Content` deja el `aria-describedby` sin
 * poner — el diálogo se anuncia con su nombre y sin decir de qué trata. Los
 * llamadores que la traen (`FormDialog`, inventario, nómina, servicios) ya
 * estaban escribiendo el texto; lo que faltaba era el vínculo.
 *
 * `DialogPrimitive.Description` renderiza un `<p>` (`Primitive.p`).
 */
const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  DialogDescriptionProps
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-text-secondary', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogTitle,
  DialogTrigger,
  computeDialogZIndex,
  computePopoverZIndex,
  usePopoverLayer,
  type DialogCloseProps,
  type DialogContentProps,
  type DialogDescriptionProps,
  type DialogFooterProps,
  type DialogHeaderProps,
  type DialogOverlayProps,
  type DialogProps,
  type DialogTitleProps,
  type DialogTriggerProps,
}
