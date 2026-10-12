"use client";

import { Search } from "lucide-react";
import * as React from "react";
import { Button } from "./button";
import { Input } from "./input";
import { cn } from "./utils";

export interface ListToolbarOption {
  value: string;
  label: string;
}

export interface ListToolbarProps extends Omit<React.FormHTMLAttributes<HTMLFormElement>, "onSubmit"> {
  searchId: string;
  searchLabel: string;
  searchValue: string;
  searchPlaceholder: string;
  onSearchChange: (value: string) => void;
  statusLabel: string;
  statusValue: string;
  statusOptions: ListToolbarOption[];
  onStatusChange: (value: string) => void;
  onFilter?: () => void;
  onClear: () => void;
  secondaryFilters?: React.ReactNode;
  activeFilterCount?: number;
}

export function ListToolbar({
  searchId,
  searchLabel,
  searchValue,
  searchPlaceholder,
  onSearchChange,
  statusLabel,
  statusValue,
  statusOptions,
  onStatusChange,
  onFilter,
  onClear,
  secondaryFilters,
  activeFilterCount = 0,
  className,
  ...props
}: ListToolbarProps) {
  const [moreOpen, setMoreOpen] = React.useState(false);

  return (
    <form
      className={cn("flex flex-col gap-3 rounded-lg border border-border-color bg-surface p-4 dark:border-border-color-2", className)}
      onSubmit={(event) => {
        event.preventDefault();
        onFilter?.();
      }}
      {...props}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-text-primary" htmlFor={searchId}>
          {searchLabel}
          <Input
            id={searchId}
            leadingIcon={<Search aria-hidden="true" className="h-4 w-4" />}
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm text-text-primary sm:min-w-40">
          {statusLabel}
          <select
            className="h-10 rounded-md border border-border-color bg-surface px-3 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:border-border-color-2"
            value={statusValue}
            onChange={(event) => onStatusChange(event.target.value)}
          >
            {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        {/* Below `sm` every action takes the full row width, so nothing overlaps. */}
        <div className="flex flex-wrap gap-2 [&>*]:flex-1 sm:[&>*]:flex-none">
          {onFilter ? <Button type="submit">Filtrar</Button> : null}
          <Button type="button" variant="outline" onClick={onClear}>Limpiar</Button>
          {secondaryFilters ? (
            <Button type="button" variant="ghost" onClick={() => setMoreOpen((open) => !open)} aria-expanded={moreOpen}>
              Más filtros
              {activeFilterCount > 0 ? <span className="rounded-full bg-surface-hover px-1.5 py-0.5 text-xs">{activeFilterCount}</span> : null}
            </Button>
          ) : null}
        </div>
      </div>
      {secondaryFilters && moreOpen ? <div className="border-t border-border-color pt-3 dark:border-border-color-2">{secondaryFilters}</div> : null}
    </form>
  );
}

export interface ListPagerProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export function ListPager({ page, pageSize, total, onPageChange }: ListPagerProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const start = total === 0 ? 0 : safePage * pageSize + 1;
  const end = Math.min(total, (safePage + 1) * pageSize);

  return (
    <nav aria-label="Paginación" className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-text-secondary">Mostrando {start}–{end} de {total}</span>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-text-secondary">Página {safePage + 1} de {pageCount}</span>
        <Button type="button" variant="outline" size="sm" disabled={safePage === 0} onClick={() => onPageChange(safePage - 1)}>Anterior</Button>
        <Button type="button" variant="outline" size="sm" disabled={safePage >= pageCount - 1} onClick={() => onPageChange(safePage + 1)}>Siguiente</Button>
      </div>
    </nav>
  );
}
