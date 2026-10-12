/**
 * Estilos del panel de administración.
 *
 * Reexporta el estándar compartido de la aplicación
 * (`@/src/shared/lib/ui-styles`) para que las secciones del panel sigan
 * importando desde aquí sin duplicar cadenas de Tailwind. El estándar
 * canónico vive en el módulo compartido.
 */
import { createElement, type InputHTMLAttributes } from "react";
import { inputClass } from "@/src/shared/lib/ui-styles";

export * from "@/src/shared/lib/ui-styles";

/** Compact COP field that keeps the caller's digit-only value contract intact. */
export function MoneyField({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return createElement(
    "span",
    { className: "relative block" },
    createElement(
      "span",
      {
        "aria-hidden": true,
        className: "pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-text-secondary",
      },
      "$",
    ),
    createElement("input", { ...props, className: `${inputClass} pl-7 ${className}` }),
  );
}
