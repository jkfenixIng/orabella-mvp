export type ArqueoMode = "none" | "denominations" | "declared_total";

export interface ArqueoMethod {
  id?: string;
  code: string;
  name: string;
  is_active: boolean;
  arqueo_mode: ArqueoMode;
}

export interface Denomination {
  id: string;
  value: number;
}

export interface ArqueoCountLine {
  method_code: string;
  denomination: number | null;
  quantity: number;
  amount: number;
}

export function arqueoMethods<T extends ArqueoMethod>(methods: T[]): {
  drawer: T | null;
  declared: T[];
} {
  const active = methods.filter((method) => method.is_active && method.arqueo_mode !== "none");
  return {
    drawer: active.find((method) => method.arqueo_mode === "denominations") ?? null,
    declared: active.filter((method) => method.arqueo_mode === "declared_total"),
  };
}

function quantity(value: string | undefined): number {
  return Math.max(0, Math.floor(Number(value ?? "0") || 0));
}

function total(value: string | undefined): number {
  return Math.max(0, Number(value ?? "0") || 0);
}

/** Builds a complete count payload for the active arqueable methods. */
export function buildArqueoCountLines(args: {
  methods: ArqueoMethod[];
  denominations: Denomination[];
  quantities: Record<string, string>;
  totals: Record<string, string>;
}): ArqueoCountLine[] {
  const { drawer, declared } = arqueoMethods(args.methods);
  return [
    ...(drawer
      ? args.denominations.map((denomination) => {
          const count = quantity(args.quantities[denomination.id]);
          return {
            method_code: drawer.code,
            denomination: Number(denomination.value),
            quantity: count,
            amount: count * Number(denomination.value),
          };
        })
      : []),
    ...declared.map((method) => ({
      method_code: method.code,
      denomination: null,
      quantity: 1,
      amount: total(args.totals[method.code]),
    })),
  ];
}
