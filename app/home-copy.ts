/** Welcome title: the first word of the user's full name, when there is one. */
export function homeWelcomeTitle(fullName: string | null | undefined): string {
  const firstName = fullName?.trim().split(/\s+/)[0];
  return firstName ? `Bienvenido, ${firstName}` : "Bienvenido";
}

/** One short sentence built from the modules this user can open. */
export function homeWelcomeDescription(moduleNames: readonly string[]): string {
  if (moduleNames.length === 0) return "Aún no tiene módulos asignados.";
  const names = moduleNames.map((name) => name.toLocaleLowerCase("es-CO"));
  const list = new Intl.ListFormat("es-CO", { style: "long", type: "conjunction" }).format(names);
  return `Desde aquí gestiona ${list}. Elija un módulo para empezar.`;
}
