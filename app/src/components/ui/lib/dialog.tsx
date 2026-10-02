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

const DialogTrigger = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Trigger>,
  DialogTriggerProps
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
        className={cn(
          'fixed left-1/2 top-1/2 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-lg border border-border-color bg-surface p-6 shadow-xl outline-none transition duration-150 data-[state=open]:scale-100 data-[state=open]:opacity-100 data-[state=closed]:scale-95 data-[state=closed]:opacity-0 dark:border-border-color-2 dark:bg-surface',
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

const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  DialogTitleProps
>(({ className, ...props }, ref) => (
  <h2
    ref={ref}
    className={cn(
      'text-lg font-semibold leading-none tracking-tight text-text-primary',
      className,
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  DialogDescriptionProps
>(({ className, ...props }, ref) => (
  <p
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
