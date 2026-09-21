'use client'

import * as React from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from './utils'

type SelectProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Root>

type SelectTriggerProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>

type SelectValueProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Value>

type SelectContentProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>

type SelectViewportProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Viewport>

type SelectGroupProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Group>

type SelectLabelProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>

type SelectItemProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>

type SelectItemTextProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.ItemText>

type SelectItemIndicatorProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.ItemIndicator>

type SelectSeparatorProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>

type SelectScrollUpButtonProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>

type SelectScrollDownButtonProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>

const Select = SelectPrimitive.Root

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-border-color bg-surface px-3 text-left text-sm text-text-primary outline-none transition-all duration-200 placeholder:text-text-tertiary focus:border-primary-600 focus:ring-2 focus:ring-primary-600/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-border-color-2 dark:bg-surface dark:text-text-primary dark:focus:border-primary-400 dark:focus:ring-primary-400/20',
      className,
    )}
    {...props}
  >
    {children}
    <ChevronDown
      aria-hidden="true"
      className="h-4 w-4 shrink-0 text-text-secondary transition-transform duration-200"
    />
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName

const SelectValue = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Value>,
  SelectValueProps
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Value
    ref={ref}
    className={cn('truncate text-text-primary', className)}
    {...props}
  />
))
SelectValue.displayName = SelectPrimitive.Value.displayName

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  SelectContentProps
>(
  (
    { className, children, position = 'popper', ...props },
    ref,
  ) => (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        className={cn(
          'relative z-50 max-h-96 min-w-[var(--radix-select-trigger-width)] overflow-y-auto overflow-x-hidden rounded-lg border border-border-color bg-surface text-sm text-text-primary shadow-lg outline-none animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 data-[state=open]:duration-150 data-[state=closed]:fade-out data-[state=closed]:zoom-out-95 data-[state=closed]:duration-100 dark:border-border-color-2 dark:bg-surface dark:text-text-primary',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className={cn('p-1', position === 'popper' && 'h-[var(--radix-select-trigger-height)] w-min min-w-[var(--radix-select-trigger-width)]')}>
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  ),
)
SelectContent.displayName = SelectPrimitive.Content.displayName

const SelectViewport = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Viewport>,
  SelectViewportProps
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Viewport
    ref={ref}
    className={cn('p-1', className)}
    {...props}
  />
))
SelectViewport.displayName = 'SelectViewport'

const SelectGroup = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Group>,
  SelectGroupProps
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Group
    ref={ref}
    className={cn('m-0 overflow-hidden p-1', className)}
    {...props}
  />
))
SelectGroup.displayName = SelectPrimitive.Group.displayName

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  SelectLabelProps
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn('px-2 py-1.5 text-xs font-medium text-text-secondary', className)}
    {...props}
  />
))
SelectLabel.displayName = SelectPrimitive.Label.displayName

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  SelectItemProps
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-default select-none items-center rounded-md py-2 pl-3 pr-10 text-sm outline-none focus:bg-primary-50 focus:text-primary-900 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 dark:focus:bg-primary-900/30 dark:focus:text-primary-100',
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="absolute right-3 flex h-4 w-4 items-center justify-center text-primary-600 dark:text-primary-400">
      <Check aria-hidden="true" className="h-4 w-4" strokeWidth={3} />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
))
SelectItem.displayName = SelectPrimitive.Item.displayName

const SelectItemText = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ItemText>,
  SelectItemTextProps
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ItemText
    ref={ref}
    className={cn('text-text-primary', className)}
    {...props}
  />
))
SelectItemText.displayName = SelectPrimitive.ItemText.displayName

const SelectItemIndicator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ItemIndicator>,
  SelectItemIndicatorProps
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ItemIndicator
    ref={ref}
    className={cn('flex h-4 w-4 items-center justify-center', className)}
    {...props}
  />
))
SelectItemIndicator.displayName = SelectPrimitive.ItemIndicator.displayName

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  SelectSeparatorProps
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-border-color', className)}
    {...props}
  />
))
SelectSeparator.displayName = SelectPrimitive.Separator.displayName

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  SelectScrollUpButtonProps
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn(
      'flex h-6 cursor-default items-center justify-center text-text-secondary',
      className,
    )}
    {...props}
  >
    <ChevronDown aria-hidden="true" className="h-4 w-4 rotate-180" />
  </SelectPrimitive.ScrollUpButton>
))
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  SelectScrollDownButtonProps
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn(
      'flex h-6 cursor-default items-center justify-center text-text-secondary',
      className,
    )}
    {...props}
  >
    <ChevronDown aria-hidden="true" className="h-4 w-4" />
  </SelectPrimitive.ScrollDownButton>
))
SelectScrollDownButton.displayName =
  SelectPrimitive.ScrollDownButton.displayName

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  SelectViewport,
  type SelectContentProps,
  type SelectGroupProps,
  type SelectItemIndicatorProps,
  type SelectItemProps,
  type SelectItemTextProps,
  type SelectLabelProps,
  type SelectProps,
  type SelectScrollDownButtonProps,
  type SelectScrollUpButtonProps,
  type SelectSeparatorProps,
  type SelectTriggerProps,
  type SelectValueProps,
  type SelectViewportProps,
}
