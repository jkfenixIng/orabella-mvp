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
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/src/components/ui/lib/tabs";
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
  /**
   * Fila de la instalación de la sesión: la siguen pidiendo `listSedeUsers`
   * (cuentas con sus roles) y el alta de la CUENTA de acceso de un empleado.
   * Los formularios de catálogos y el legajo ya no la envían: el servidor la
   * resuelve y la columnanullable ya no la exige.
   */
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
    const result: ActionResult<SedeUserRow[]> = await listSedeUsersAction();
    if (result.success) setUsers(result.data);
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => setTab(next as Tab)}
      label="Secciones de administración"
      className="gap-4"
    >
      <TabsList>
        {TABS.map((option) => (
          <TabsTrigger key={option.value} value={option.value}>
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsPanel value="empleados">
        <EmployeesSection
          sedeId={props.sedeId}
          initial={props.initialEmployees}
          users={users}
          onUsersChanged={() => void refreshUsers()}
        />
      </TabsPanel>
      <TabsPanel value="roles">
        <UsersSection
          key={users.map((user) => user.id).join(",")}
          initial={users}
          currentUserId={props.currentUserId}
        />
      </TabsPanel>
      <TabsPanel value="impuestos">
        <TaxesSection initial={props.initialTaxes} />
      </TabsPanel>
      <TabsPanel value="metodos">
        <MethodsSection initial={props.initialMethods} />
      </TabsPanel>
      <TabsPanel value="vales">
        <ValesSection initial={props.initialVoucherSettings} />
      </TabsPanel>
      <TabsPanel value="caja">
        <CashSection
          initialRegisters={props.initialRegisters}
          initialDenominations={props.initialDenominations}
        />
      </TabsPanel>
    </Tabs>
  );
}
