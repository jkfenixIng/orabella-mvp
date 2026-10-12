import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const client = readFileSync(join(process.cwd(), "app", "invoices", "invoices-client.tsx"), "utf8");

describe("invoice payment and list layout", () => {
  it("keeps split-payment portions, remaining total, and an exact-total pay guard", () => {
    expect(client).toContain("const [splitDrafts, setSplitDrafts] = useState<PortionDraft[]>");
    expect(client).toContain("setSplitDrafts((prev) => [...prev,");
    expect(client).toContain("setSplitDrafts((prev) => prev.filter((_, index) => index !== portionIndex))");
    expect(client).toContain("const splitRemaining = Math.max(0, splitDifference);");
    expect(client).toContain("const canSubmitSplit = moneyEquals(splitDifference, 0) && splitDrafts.every");
    expect(client).toContain("portions: parsedSplitPortions");
  });

  it("contains row actions in a wrapping grid cell without absolute positioning", () => {
    const actions = client.slice(client.indexOf('className="invoice-row-actions'), client.indexOf("{/* Abajo de `sm` el cierre"));
    expect(actions).toContain("invoice-row-actions");
    expect(actions).toMatch(/\bflex\b[\s\S]*\bflex-wrap\b/);
    expect(actions).not.toMatch(/\babsolute\b/);
    expect(actions).toContain("max-sm:min-h-11 max-sm:min-w-11");
  });

  it("aligns filter controls at their bottom edge and expands them on narrow screens", () => {
    expect(client).toContain('className="grid items-end gap-3');
    expect(client).toContain("max-sm:w-full");
  });

  it("spaces annul actions from the motive field in a responsive footer", () => {
    expect(client).toContain('className="flex flex-col-reverse gap-3 border-t border-border-color pt-4 sm:flex-row sm:justify-end"');
    expect(client).toContain('className="flex flex-col gap-5"');
  });

  it("keeps payment available from an emitted invoice detail and isolates the customer preview", () => {
    expect(client).toContain('const canPayDetail = props.canWrite && detail?.invoice.status === "Emitida"');
    expect(client).toContain('Pagar factura');
    expect(client).toContain('openPaymentFromDetail');
    expect(client).toContain('setCustomerPreviewOpen(true)');
    expect(client).toContain('Dialog open={customerPreviewOpen}');
    expect(client).toContain('Vista para cliente');
  });

  it("uses tokenized paper surfaces for invoice dialogs and MoneyInput for split amounts", () => {
    const sheet = client.match(/const paperSheetClass =\s*"([^"]+)"/)?.[1] ?? "";
    expect(sheet.split(" ")).toEqual(expect.arrayContaining(["bg-paper-surface", "shadow-2xl", "dark:shadow-none", "dark:ring-border-color-2"]));
    // Create, detail, edit, item, preview, commission and confirm sheets.
    expect(client.match(/\bpaperSheetClass\)?\}/g)?.length).toBe(7);
    expect(client).not.toContain("rgba(255,255,255");
    expect(client).toContain('<MoneyInput className={inputClass}');
    expect(client).toContain('onValueChange={(amount) => setSplitDrafts');
  });
});
