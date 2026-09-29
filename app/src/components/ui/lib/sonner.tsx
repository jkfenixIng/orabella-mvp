'use client'

import {
  CircleCheck,
  Info,
  Loader2,
  OctagonX,
  TriangleAlert,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import type { CSSProperties } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

/* --------------------------------------------------------------------------
   Toaster — primitiva de toast de shadcn (base sonner), adaptada al proyecto.

   Qué se cambió respecto del registry y por qué:

   1. Tema: sale de `useTheme()` de next-themes, igual que el registry, porque
      el ThemeProvider del proyecto usa `attribute="class"` y sin cablearlo el
      toast se quedaría en claro sobre una app en oscuro.
   2. Variables de color: el registry apunta a los alias del registry
      (`--popover`, `--popover-foreground`, `--border`). Acá se apunta
      DIRECTO a los tokens del proyecto —`--bg-surface`, `--text-primary`,
      `--color-border-color`, `--radius`— que son exactamente lo que esos alias
      resuelven en globals.css. Se evita un salto de indirección: si alguien
      retoca el alias, el toast no queda descolgado en silencio.
   3. `position="top-right"`: la acción de los formularios y el contenido
      principal viven en el centro/abajo, así que abajo a la derecha tapaba lo
      que el usuario acaba de mirar. Arriba a la derecha queda al lado de la
      campana de alertas del shell, que es donde ya está mirando.
   4. `closeButton`: el defecto que esta primitiva viene a arreglar es el
      mensaje que no se va nunca. El toast se va solo y además se puede cerrar.

   NO se activa `richColors`. En sonner 2.x las variables por tipo
   (`--success-bg`, `--error-bg`, …) solo aplican bajo `[data-rich-colors='true']`
   y sus valores en oscuro son la paleta propia de sonner, no la del proyecto.
   Pisarlas con `--color-*-50` tampoco sirve: ese peldaño NO se invierte en
   `.dark` (lo que se invierte es la CLASE `.dark .bg-*-light`), así que en
   oscuro el toast quedaría casi blanco. O sea: el tinte por tipo necesita un
   override en `globals.css`, que está fuera de esta unidad de trabajo. Hasta
   entonces, superficie uniforme del proyecto + icono distinto por tipo.
   -------------------------------------------------------------------------- */

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      position="top-right"
      closeButton
      className="toaster group"
      icons={{
        success: <CircleCheck className="size-4" />,
        info: <Info className="size-4" />,
        warning: <TriangleAlert className="size-4" />,
        error: <OctagonX className="size-4" />,
        loading: <Loader2 className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--bg-surface)',
          '--normal-text': 'var(--text-primary)',
          '--normal-border': 'var(--color-border-color)',
          '--border-radius': 'var(--radius)',
        } as CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
