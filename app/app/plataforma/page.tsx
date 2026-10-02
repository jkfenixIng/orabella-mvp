import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Badge } from "@/src/components/ui/lib/badge";
import { EmptyState } from "@/src/components/ui/lib/empty-state";
import { PageContainer, PageHeader } from "@/src/components/ui/lib/page";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  PlatformError,
  readPlatformInstallation,
  requirePlatformAdmin,
  type PlatformActor,
  type PlatformInstallationRow,
} from "@/src/features/platform/service";
import { PlataformaPayrollStartDateForm } from "./plataforma-client";
import { sectionClass, sectionTitleClass } from "@/src/shared/lib/ui-styles";

export const dynamic = "force-dynamic";

/**
 * SUPERFICIE de plataforma — configuración de la INSTALACIÓN.
 *
 * Solo la cuenta con el rol `superadmin` la ve: la guarda `requirePlatformAdmin`
 * es la primera llamada y es la única puerta. Quien no pasa NO ve una pantalla
 * con datos vacíos: se lo manda al ingreso si no hay sesión, y al inicio si hay
 * sesión pero le falta el rol. Es el mismo criterio que usan `/admin` y
 * `/payroll` para una página que no le corresponde a su rol.
 *
 * La instalación es de UNA SOLA SEDE (decisión del dueño 2026-10-01): la pantalla
 * presenta esa instalación —su nombre, su estado y desde cuándo opera su
 * nómina— y no una lista. No hay sedes que crear, listar ni administrar aquí: la
 * gestión de usuarios es del admin de la sede (`/admin`), y el rol de plataforma
 * no se otorga ni se quita desde ninguna de las dos puertas.
 *
 * Las escrituras NO viven acá: la isla cliente pide la acción de plataforma, que
 * re-aplica la guarda en el servidor.
 */
export default async function PlataformaPage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;

  let actor: PlatformActor | null = null;
  try {
    actor = await requirePlatformAdmin(token);
  } catch (error) {
    if (error instanceof PlatformError && error.code === "UNAUTHENTICATED") {
      redirect("/login?next=/plataforma");
    }
    redirect("/");
  }
  if (!actor) redirect("/");

  // Sin sede activa no hay instalación que configurar: es un estado que el dueño
  // resuelve activando la sede del negocio, no una pantalla vacía que parezca
  // que todo está bien.
  let instalacion: PlatformInstallationRow | null = null;
  try {
    instalacion = await readPlatformInstallation(actor);
  } catch (error) {
    if (!(error instanceof PlatformError) || error.code !== "NOT_FOUND") throw error;
  }

  return (
    <PageContainer>
      <PageHeader
        title="Plataforma"
        description="Configuración de la instalación: desde cuándo opera su nómina."
      />
      <p className="text-sm text-text-secondary">
        Esta instalación opera una sola sede. Desde acá se configura el SISTEMA: la
        fecha de inicio de su nómina. Los usuarios de la sede y sus roles los administra
        el admin de la sede, en /admin.
      </p>

      {instalacion === null ? (
        <EmptyState>
          La instalación no tiene ninguna sede activa: active la sede del negocio para
          poder configurarla.
        </EmptyState>
      ) : (
        <section className={sectionClass} aria-label="Instalación">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={sectionTitleClass}>{instalacion.name}</h2>
            <Badge variant={instalacion.is_active ? "success" : "secondary"}>
              {instalacion.is_active ? "Activa" : "Inactiva"}
            </Badge>
          </div>
          <PlataformaPayrollStartDateForm
            installationName={instalacion.name}
            initialPayrollStartDate={instalacion.payroll_start_date}
          />
        </section>
      )}
    </PageContainer>
  );
}