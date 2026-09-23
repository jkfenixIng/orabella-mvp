import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import {
  listEmployees,
  listPaymentMethods,
  listServices,
  listTaxes,
} from "@/src/features/admin/service";
import { listProducts } from "@/src/features/inventory/service";
import { countInvoices, listInvoices } from "@/src/features/billing/service";
import { InvoicesClient } from "./invoices-client";

export const dynamic = "force-dynamic";

/**
 * T5 — factura interna (FAC-01…07, sin DIAN). Lectura: cualquier rol
 * autenticado de su sede. Escritura (emitir/cobrar): admin/caja; anular:
 * solo admin (el servidor lo refuerza en ambos casos).
 */
export default async function InvoicesPage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  const session = await getSessionUser(token);
  if (!session) redirect("/login?next=/invoices");

  const sedeId = session.user.sede_id;
  if (!sedeId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 px-6 py-12">
        <h1 className="text-2xl font-bold">Facturación</h1>
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          El usuario no tiene sede asignada.
        </p>
      </main>
    );
  }

  const canWrite = session.roles.includes("admin") || session.roles.includes("caja");
  const isAdmin = session.roles.includes("admin");
  const isManager = isAdmin || session.roles.includes("caja");
  // F1: el listado abre solo con las facturas del día (fecha local del
  // servidor); el resto se consulta limpiando los filtros de fecha.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  // Empleado: solo sus facturas (filtro forzado para que el total cuadre).
  const pageFilters = { page: 1, from: today, to: today, ...(isManager ? {} : { user_id: session.user.id }) };
  const [invoices, totalInvoices, products, services, employees, methods, taxes] = await Promise.all([
    listInvoices(sedeId, pageFilters),
    countInvoices(sedeId, { from: today, to: today, ...(isManager ? {} : { user_id: session.user.id })}),
    listProducts(sedeId),
    listServices(sedeId),
    listEmployees(sedeId),
    listPaymentMethods(sedeId),
    listTaxes(sedeId),
  ]);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Facturación</h1>
          <p className="mt-2 text-slate-600 dark:text-slate-300">
            Facturas, impuestos y cobros.
          </p>
        </div>
      </header>
      <InvoicesClient
        sedeId={sedeId}
        initialInvoices={invoices}
        initialTotal={totalInvoices}
        products={products}
        services={services}
        employees={employees.filter((row) => row.is_active)}
        methods={methods.filter((row) => row.is_active)}
        taxes={taxes.filter((row) => row.is_active)}
        canWrite={canWrite}
        canAnnul={session.roles.includes("admin")}
        isAdmin={isAdmin}
        currentUserId={session.user.id}
        detailMode={isAdmin ? "full" : isManager ? "open-only" : "none"}
      />
    </main>
  );
}
