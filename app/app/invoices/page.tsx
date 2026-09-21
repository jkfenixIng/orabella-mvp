import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import {
  listEmployees,
  listPaymentMethods,
  listServices,
} from "@/src/features/admin/service";
import { listProducts } from "@/src/features/inventory/service";
import { listInvoices } from "@/src/features/billing/service";
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

  const [invoices, products, services, employees, methods] = await Promise.all([
    listInvoices(sedeId),
    listProducts(sedeId),
    listServices(sedeId),
    listEmployees(sedeId),
    listPaymentMethods(sedeId),
  ]);

  const canWrite = session.roles.includes("admin") || session.roles.includes("caja");

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Facturación</h1>
          <p className="mt-2 text-slate-600 dark:text-slate-300">
            Factura interna con consecutivo por sede, impuestos y cobro dividido.
          </p>
        </div>
      </header>
      <InvoicesClient
        sedeId={sedeId}
        initialInvoices={invoices}
        products={products}
        services={services}
        employees={employees.filter((row) => row.is_active)}
        methods={methods.filter((row) => row.is_active)}
        canWrite={canWrite}
        canAnnul={session.roles.includes("admin")}
      />
    </main>
  );
}
