import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { LoginForm } from "./login-form";

interface LoginPageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const store = await cookies();
  if (store.get(SESSION_COOKIE_NAME)?.value) redirect("/");
  const params = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 px-6 py-12">
      <header>
        <h1 className="text-3xl font-bold">Orabella</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          Ingrese con su número de documento y su clave.
        </p>
      </header>
      <LoginForm next={params.next} />
    </main>
  );
}
