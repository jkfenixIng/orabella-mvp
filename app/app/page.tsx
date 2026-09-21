import Link from "next/link";
import dynamic from "next/dynamic";
import { Suspense } from "react";

import { Skeleton } from "@/src/shared/components/skeleton";

const MODULES = [
  {
    href: "/invoices",
    name: "Facturación",
    purpose: "Cree las cuentas de sus clientes y reciba pagos en efectivo, tarjeta o mezcla de ambos.",
  },
  {
    href: "/cash",
    name: "Caja",
    purpose: "Abra y cierre turnos, registre movimientos y consulte el arqueo del día.",
  },
  {
    href: "/inventory",
    name: "Inventario",
    purpose: "Controle los productos de la tienda: existencias, entradas, salidas y alertas de poco stock.",
  },
  {
    href: "/admin",
    name: "Administración",
    purpose: "Gestione empleados, servicios, precios, impuestos y formas de pago de su sede.",
  },
  {
    href: "/payroll",
    name: "Nómina y vales",
    purpose: "Calcule la nómina del personal desde la facturación y controle vales y aprobaciones.",
  },
] as const;

// Heavy components loaded dynamically with Suspense
const InvoicesClient = dynamic(() => import("@/app/invoices/invoices-client").then((m) => m.InvoicesClient), {
  ssr: false,
});
const InventoryClient = dynamic(() => import("@/app/inventory/inventory-client").then((m) => m.InventoryClient), {
  ssr: false,
});
const CashClient = dynamic(() => import("@/app/cash/cash-client").then((m) => m.CashClient), {
  ssr: false,
});
const PayrollClient = dynamic(() => import("@/app/payroll/payroll-client").then((m) => m.PayrollClient), {
  ssr: false,
});
const AdminTabs = dynamic(() => import("@/app/admin/admin-tabs").then((m) => m.AdminTabs), {
  ssr: false,
});

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-8 px-6 py-12">
      <header>
        <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Bienvenido a</p>
        <h1 className="mt-1 text-3xl font-bold">Orabella</h1>
        <p className="mt-2 text-slate-600 dark:text-slate-300">
          El sistema de su negocio de belleza: ventas, caja, inventario y personal en un solo lugar.
          Elija un módulo para empezar.
        </p>
      </header>

      <section aria-label="Módulos del sistema">
        <Suspense fallback={<div className="h-96 bg-slate-100 dark:bg-slate-800 animate-pulse rounded-lg"></div>}>
          <ul className="grid gap-4 sm:grid-cols-2">
            {MODULES.map((module) => (
              <li
                key={module.href}
                className="flex flex-col gap-2 rounded-lg border border-slate-300 p-4 dark:border-slate-700"
              >
                <h2 className="text-lg font-semibold">{module.name}</h2>
                <p className="text-sm text-slate-600 dark:text-slate-300">{module.purpose}</p>
                <Link
                  href={module.href}
                  aria-label={`Ir a ${module.name}`}
                  className="mt-auto inline-block w-fit rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
                >
                  Entrar
                </Link>
              </li>
            ))}
          </ul>
        </Suspense>
      </section>

      {/* Heavy components shown conditionally under Suspense */}
      <section aria-label="Componentes pesados" className="mt-8">
        <Suspense fallback={<div className="h-64 bg-slate-100 dark:bg-slate-800 animate-pulse rounded-lg"></div>}>
          <InvoicesClient SedeId="sede1" />
        </Suspense>
        <Suspense fallback={<div className="h-64 bg-slate-100 dark:bg-slate-800 animate-pulse rounded-lg"></div>}>
          <InventoryClient SedeId="sede1" initialProducts={[]} initialAlertIds={[]} canWrite={false} />
        </Suspense>
        <Suspense fallback={<div className="h-64 bg-slate-100 dark:bg-slate-800 animate-pulse rounded-lg"></div>}>
          <CashClient SedeId="sede1" today={new Date().toISOString().split('T')[0]} initialRegisters={[]} initialOpenShift={null} initialDay={ { fecha: new Date().toISOString().split('T')[0] } } initialHistory={{ desde: new Date().toISOString().split('T')[0], hasta: new Date().toISOString().split('T')[0], shifts: [] }} methods={[]} canWrite={false} />
        </Suspense>
        <Suspense fallback={<div className="h-64 bg-slate-100 dark:bg-slate-800 animate-pulse rounded-lg"></div>}>
          <PayrollClient SedeId="sede1" initialEmployees={[]} initialPeriods={[]} initialSettings={null} initialVouchers={[]} methods={[]} canAdmin={false} canPay={false} />
        </Suspense>
        <Suspense fallback={<div className="h-64 bg-slate-100 dark:bg-slate-800 animate-pulse rounded-lg"></div>}>
          <AdminTabs SedeId="sedeId" initialEmployees={[]} initialServices={[]} initialTaxes={[]} initialMethods={[]} />
        </Suspense>
      </section>
    </main>
  );
}