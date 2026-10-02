import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Alert } from "@/src/components/ui/lib/alert";
import { PageContainer, PageHeader } from "@/src/components/ui/lib/page";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import { listEmployees, listPaymentMethods } from "@/src/features/admin/service";
import { getOpenShiftWithOpener } from "@/src/features/cash/service";
import {
  getVoucherSettings,
  listVouchers,
} from "@/src/features/payroll/service";
import { bogotaDay } from "@/src/shared/lib/dates";
import { VouchersClient } from "./vouchers-client";

export const dynamic = "force-dynamic";

/**
 * Vales como módulo propio (PERM-02): caja puede emitir vales sin entrar a
 * nómina; empleado ve los suyos (alcance en PERM-03); admin lo gestiona.
 */
export default async function ValesPage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  const session = await getSessionUser(token);
  if (!session) redirect("/login?next=/vales");

  const sedeId = session.user.sede_id;
  if (!sedeId) {
    return (
      <PageContainer size="narrow">
        <PageHeader title="Vales" />
        {/* Sin sede no hay vales que mostrar: es ESTADO (el caso hasta que a
            alguien se le asigne una sede), así que va inline y persistente.
            Esta vista es un Server Component: no puede emitir un toast. El
            texto es el mismo; `destructive` deriva role="alert", el mismo
            anuncio asertivo que antes estaba escrito a mano. */}
        <Alert variant="destructive">El usuario no tiene sede asignada.</Alert>
      </PageContainer>
    );
  }

  // Por defecto la pantalla muestra SOLO los vales de hoy (día de Bogotá). El
  // rango se calcula UNA vez acá y baja como prop para que servidor y cliente
  // no puedan discrepar; ampliarlo (o limpiarlo) es cosa del cliente.
  const today = bogotaDay();
  const [employees, settings, vouchers, methods, shift] = await Promise.all([
    listEmployees(sedeId),
    getVoucherSettings(sedeId),
    listVouchers(sedeId, { date_from: today, date_to: today }),
    listPaymentMethods(sedeId),
    getOpenShiftWithOpener(sedeId),
  ]);

  const isAdmin = session.roles.includes("admin");
  const canIssue = isAdmin || session.roles.includes("caja");
  // La caja abierta es quien abre el vale: el cliente avisa temprano y el
  // servidor vuelve a validar (dueño del turno o admin).
  const shiftOpen = shift !== null;
  const shiftOwn = shift === null || shift.opened_by === session.user.id || isAdmin;
  const shiftOwner = shift?.opener_name?.trim() || null;
  // Empleado: solo sus vales y sin nómina de empleados (no ve el personal).
  const ownId = canIssue
    ? undefined
    : employees.find((row) => row.user_id === session.user.id)?.id ?? "sin-acceso";

  return (
    <PageContainer>
      <PageHeader
        title="Vales"
        description="La caja abre el vale al empleado con topes por día y semana, días permitidos y revisión del admin."
      />
      <VouchersClient
        initialEmployees={canIssue ? employees : []}
        initialSettings={settings}
        initialVouchers={ownId ? vouchers.filter((row) => row.employee_id === ownId) : vouchers}
        initialMethods={methods.filter((row) => row.is_active && row.arqueable)}
        today={today}
        shiftOpen={shiftOpen}
        shiftOwn={shiftOwn}
        shiftOwner={shiftOwner}
        canAdmin={isAdmin}
        canIssue={canIssue}
      />
    </PageContainer>
  );
}
