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

const Dialog = DialogPrimitive.Root
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
      'fixed inset-0 z-40 bg-black/60 animate-in data-[state=open]:fade-in data-[state=closed]:fade-out-0 data-[state=closed]:duration-150',
      className,
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-lg border border-border-color bg-surface p-6 shadow-xl outline-none animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 data-[state=open]:duration-150 data-[state=closed]:fade-out data-[state=closed]:zoom-out-95 data-[state=closed]:duration-100 dark:border-border-color-2 dark:bg-surface',
        className,
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
))
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
