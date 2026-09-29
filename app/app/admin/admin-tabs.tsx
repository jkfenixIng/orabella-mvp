"use client";

import { useState } from "react";
import { listSedeUsersAction } from "@/src/features/admin/actions";
import type {
  EmployeeRow,
  PaymentMethodRow,
  SedeUserRow,
  TaxConfigRow,
} from "@/src/features/admin/service";
import type { VoucherSettingsRow } from "@/src/features/payroll/service";
import type { CashDenominationRow, CashRegisterRow } from "@/src/features/cash/service";
import { EmployeesSection } from "./admin-sections/employees-section";
import { UsersSection } from "./admin-sections/users-section";
import { TaxesSection } from "./admin-sections/taxes-section";
import { MethodsSection } from "./admin-sections/methods-section";
import { ValesSection } from "./admin-sections/vales-section";
import { CashSection } from "./admin-sections/cash-section";
import type { ActionResult } from "./admin-shared";

type Tab = "empleados" | "roles" | "impuestos" | "metodos" | "vales" | "caja";

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "empleados", label: "Empleados" },
  { value: "roles", label: "Roles" },
  { value: "impuestos", label: "Impuestos" },
  { value: "metodos", label: "Métodos de pago" },
  { value: "vales", label: "Vales" },
  { value: "caja", label: "Caja" },
];

interface AdminTabsProps {
  sedeId: string;
  currentUserId: string;
  initialEmployees: EmployeeRow[];
  initialUsers: SedeUserRow[];
  initialTaxes: TaxConfigRow[];
  initialMethods: PaymentMethodRow[];
  initialVoucherSettings: VoucherSettingsRow | null;
  initialRegisters: CashRegisterRow[];
  initialDenominations: CashDenominationRow[];
}

export function AdminTabs(props: AdminTabsProps) {
  const [tab, setTab] = useState<Tab>("empleados");
  const [users, setUsers] = useState(props.initialUsers);

  async function refreshUsers() {
    const result: ActionResult<SedeUserRow[]> = await listSedeUsersAction(props.sedeId);
    if (result.success) setUsers(result.data);
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-border-color bg-surface p-1 shadow-sm dark:border-border-color-2"
        role="tablist"
        aria-label="Secciones de administración"
      >
        {TABS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={tab === option.value}
            onClick={() => setTab(option.value)}
            className={
              tab === option.value
                ? "rounded-md bg-primary-600 px-3 py-1 text-sm text-white"
                : "rounded-md px-3 py-1 text-sm text-text-secondary hover:bg-surface-hover"
            }
          >
            {option.label}
          </button>
        ))}
      </div>

      {tab === "empleados" ? (
        <EmployeesSection
          sedeId={props.sedeId}
          initial={props.initialEmployees}
          users={users}
          onUsersChanged={() => void refreshUsers()}
        />
      ) : null}
      {tab === "roles" ? (
        <UsersSection
          key={users.map((user) => user.id).join(",")}
          sedeId={props.sedeId}
          initial={users}
          currentUserId={props.currentUserId}
        />
      ) : null}
      {tab === "impuestos" ? (
        <TaxesSection sedeId={props.sedeId} initial={props.initialTaxes} />
      ) : null}
      {tab === "metodos" ? (
        <MethodsSection sedeId={props.sedeId} initial={props.initialMethods} />
      ) : null}
      {tab === "vales" ? (
        <ValesSection initial={props.initialVoucherSettings} />
      ) : null}
      {tab === "caja" ? (
        <CashSection
          initialRegisters={props.initialRegisters}
          initialDenominations={props.initialDenominations}
        />
      ) : null}
    </div>
  );
}
