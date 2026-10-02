import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Badge } from "@/src/components/ui/lib/badge";
import { EmptyState } from "@/src/components/ui/lib/empty-state";
import { PageContainer, PageHeader } from "@/src/components/ui/lib/page";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  listPlatformSedes,
  PlatformError,
  requirePlatformAdmin,
  type PlatformActor,
} from "@/src/features/platform/service";
import {
  PlataformaCreateSedeForm,
  PlataformaPayrollStartDateForm,
  PlataformaSedeRolesSection,
} from "./plataforma-client";
import { sectionClass, sectionTitleClass } from "@/src/shared/lib/ui-styles";

export const dynamic = "force-dynamic";

/**
 * G3a/G3b/G5 — SUPERFICIE de plataforma.
 *
 * Solo la cuenta con el rol `superadmin` la ve: la guarda `requirePlatformAdmin`
 * es la primera llamada y es la única puerta. Quien no pasa NO ve una pantalla
 * con datos vacíos: se lo manda al ingreso si no hay sesión, y al inicio si hay
 * sesión pero le falta el rol. Es el mismo criterio que usan `/admin` y
 * `/payroll` para una página que no le corresponde a su rol.
 *
 * Administra la INSTALACIÓN, no el negocio: lista las sedes de la instalación,
 * las crea, decide quién administra cada una y configura desde cuándo opera su
 * nómina. Las escrituras NO viven acá: las islas cliente piden las acciones de
 * plataforma, que re-aplican la guarda en el servidor.
 *
 * La fila de la sede del sistema se reconoce por su marca de dato
 * (`is_platform`), nunca por su nombre: es donde se ancla la cuenta de
 * plataforma (G2), no es una sede del negocio, y por eso no ofrece ni la fecha
 * de nómina ni la gestión de sus usuarios.
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

  const sedes = await listPlatformSedes(actor);

  return (
    <PageContainer>
      <PageHeader
        title="Plataforma"
        description="Configuración de la instalación: las sedes, quién administra cada una y desde cuándo opera su nómina."
      />
      <p className="text-sm text-text-secondary">
        El estado de la instalación lo ve únicamente la cuenta de plataforma. Desde
        acá se crean las sedes, se decide quién administra cada una y se configura la
        fecha de inicio de su nómina. La sede del sistema no es una sede del negocio.
      </p>

      <section className={sectionClass} aria-label="Alta de sede">
        <h2 className={sectionTitleClass}>Crear una sede</h2>
        <PlataformaCreateSedeForm />
      </section>

      {sedes.length === 0 ? (
        <EmptyState>Todavía no hay sedes en la instalación.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {sedes.map((sede) => (
            <li
              key={sede.id}
              className="flex flex-col gap-2 rounded-lg border border-border-color bg-surface p-4 dark:border-border-color-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-text-primary">{sede.name}</h2>
                <Badge variant={sede.is_active ? "success" : "secondary"}>
                  {sede.is_active ? "Activa" : "Inactiva"}
                </Badge>
                {sede.is_platform ? <Badge variant="outline">Sede del sistema</Badge> : null}
              </div>
              {sede.is_platform ? (
                <p className="text-sm text-text-secondary">
                  No es una sede del negocio: es donde se ancla la cuenta de
                  plataforma.
                </p>
              ) : (
                <>
                  <PlataformaPayrollStartDateForm
                    sedeId={sede.id}
                    sedeName={sede.name}
                    initialPayrollStartDate={sede.payroll_start_date}
                  />
                  <PlataformaSedeRolesSection sedeId={sede.id} sedeName={sede.name} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}