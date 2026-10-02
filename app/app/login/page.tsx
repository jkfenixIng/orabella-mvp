import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import { PageContainer, PageHeader } from "@/src/components/ui/lib/page";
import { LoginForm } from "./login-form";

interface LoginPageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  // Validate against the DB instead of presence only: a stale/invalid
  // cookie must stay on /login (re-login overwrites it) instead of
  // bouncing to "/" which redirects back here (infinite loop).
  if (token) {
    const session = await getSessionUser(token);
    if (session) redirect("/");
  }
  const params = await searchParams;

  return (
    <PageContainer size="narrow">
      {/* `text-sm`: la descripción del ingreso era la única del proyecto con
          ese tamaño explícito (las demás heredan el default). Se pliega al
          header en vez de perderlo: el `<h1>` tiene su propio `text-3xl` y no
          lo toca. */}
      <PageHeader
        className="text-sm"
        title="Orabella"
        description="Ingrese con su número de documento y su clave."
      />
      <LoginForm next={params.next} />
    </PageContainer>
  );
}
