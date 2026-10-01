import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Alert } from "@/src/components/ui/lib/alert";
import { PageContainer, PageHeader } from "@/src/components/ui/lib/page";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import { listAllEmployees, listPaymentMethods } from "@/src/features/admin/service";
import { listPayrollOverview, listPeriods } from "@/src/features/payroll/service";
import { PayrollClient } from "./payroll-client";

export const dynamic = "force-dynamic";

/**
 * T7 — nómina y vales (PAY-01…07).
 *
 * Nómina: la administra el admin de la sede; el empleado entra a ver SU recibo
 * (periodo y detalle con alcance por fila). La caja no entra —ni la página ni el
 * API—: el módulo de nómina es del administrador, que es quien la genera y la
 * revisa. El vale de la caja vive en /vales.
 */
export default async function PayrollPage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  const session = await getSessionUser(token);
  if (!session) redirect("/login?next=/payroll");
  if (!session.roles.includes("admin") && !session.roles.includes("empleado")) redirect("/");

  const sedeId = session.user.sede_id;
  if (!sedeId) {
    return (
      <PageContainer size="narrow">
        <PageHeader title="Nómina" />
        {/* Sin sede no hay nómina que mostrar: es ESTADO (el caso hasta que a
            alguien se le asigne una sede), así que va inline y persistente.
            Esta vista es un Server Component: no puede emitir un toast. El
            texto es el mismo; `destructive` deriva role="alert", el mismo
            anuncio asertivo que antes estaba escrito a mano. */}
        <Alert variant="destructive">El usuario no tiene sede asignada.</Alert>
      </PageContainer>
    );
  }

  const canAdmin = session.roles.includes("admin");
  // Pagar un ítem es del admin igual que el resto del módulo: el guard del
  // servidor (requirePayrollAdmin) y el botón no pueden decir cosas distintas
  // (antes `canPay` sumaba `caja` en una página que a la caja la redirige arriba).
  const canPay = canAdmin;

  // PA3: la planta COMPLETA (`listAllEmployees`), no el listado de navegación.
  // `listEmployees` corta en 50 (`clampLimit`) y con más planta que eso los
  // nombres de la nómina caían al fragmento del id (y el tipo de pago a "Sin
  // definir"): las filas seguían ahí, ilegibles. U7 cerró el extremo que ARMA la
  // nómina; acá se cierra el que MIRA.
  //
  // El resumen (totales por período y mes a la fecha por empleado) agrega plata
  // de TODA la planta —el mismo dato que el detalle sin alcance por fila—, así
  // que SOLO el admin lo recibe. Al empleado se le manda únicamente su propia
  // fila: pasarle la planta entera sería exponerle documentos, teléfonos y
  // sueldos ajenos.
  const [employees, methods, overview] = await Promise.all([
    listAllEmployees(sedeId),
    listPaymentMethods(sedeId),
    canAdmin ? listPayrollOverview(sedeId) : null,
  ]);

  // El admin ya tiene los períodos dentro del resumen: se usan esos y la lectura
  // no se repite. El empleado lee la lista pelada, como antes.
  const periods = overview ? overview.summaries.map((row) => row.period) : await listPeriods(sedeId);
  const visibleEmployees = canAdmin
    ? employees
    : employees.filter((row) => row.user_id === session.user.id);

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Nómina"
        description="Periodos con cálculo desde facturación y pago por porciones."
      />
      <PayrollClient
        sedeId={sedeId}
        initialEmployees={visibleEmployees}
        initialPeriods={periods}
        initialSummaries={overview?.summaries ?? []}
        initialMonthToDate={overview?.months ?? []}
        methods={methods.filter((row) => row.is_active)}
        canAdmin={canAdmin}
        canPay={canPay}
      />
    </PageContainer>
  );
}
