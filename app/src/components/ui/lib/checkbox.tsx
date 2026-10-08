'use client'

import * as React from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check } from 'lucide-react'
import { cn } from './utils'

type CheckboxProps = React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>;

// R13 (medido en Chromium): la casilla daba 16×16 px, contra el piso DURO de
// 24×24 px del repo (WCAG 2.5.8 AA, `docs/ux-ui-standard.md` §8).
//
// El arreglo agranda el BLANCO TÁCTIL y no la caja visible: `relative` + el
// `::after` que se sale de la caja. Sin cambiar un píxel de lo que se ve y sin
// ocupar un píxel más en el flujo. Por eso NO lleva `max-sm:`: 24 px es el
// piso duro y no tiene excepción de escritorio, y acá la densidad no se paga
// porque la caja sigue midiendo 16.
//
// LA CUENTA DEL INSET NO ES LA INTUITIVA, y el navegador la corrigió: el
// `::after` se posiciona contra la CAJA DE RELLENO, o sea los 16 px MENOS los
// 2 del borde. Con `after:-inset-1` (4 px) el hit medido daba 22×22 px, por
// debajo del piso. `after:-inset-1.5` son 6 px por lado: 14 + 12 = 26×26 px
// medidos. El token que se ve (16) y el blanco que se toca (26) son dos
// cosas distintas.
//
// La alternativa obvia —cambiar `h-4 w-4` por `h-6 w-6`— agranda el control
// visible y desplaza las etiquetas que lo envuelven (los dos usos del repo
// están dentro de un `Label` con `flex-row`): se arreglaría el táctil
// rompiendo la lectura de la fila. En Tailwind v4 el `::after` de la variante
// `after:` nace con `content: ''`, así que no hace falta declararlo.
const CHECKBOX_ROOT_CLASS =
  'peer relative h-4 w-4 shrink-0 rounded-[4px] border border-border-color bg-surface text-transparent outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary-600 data-[state=checked]:bg-primary-600 data-[state=checked]:text-white after:absolute after:-inset-1.5';

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  CheckboxProps
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(CHECKBOX_ROOT_CLASS, className)}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn('flex items-center justify-center text-current')}
    >
      <Check className="h-3 w-3" strokeWidth={3} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
