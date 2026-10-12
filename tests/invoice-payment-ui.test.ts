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

  it("keeps only the customer preview paper-like and uses semantic dark surfaces for workflows", () => {
    const paperSheet = client.match(/const paperSheetClass =\s*"([^"]+)"/)?.[1] ?? "";
    const workflowSheet = client.match(/const workflowSheetClass =\s*"([^"]+)"/)?.[1] ?? "";
    expect(paperSheet.split(" ")).toEqual(expect.arrayContaining(["bg-paper-surface", "shadow-2xl"]));
    expect(workflowSheet.split(" ")).toEqual(expect.arrayContaining(["border-border-color", "bg-surface", "text-text-primary", "dark:border-border-color-2", "dark:bg-surface"]));
    expect(client.match(/\bpaperSheetClass\)?\}/g)?.length).toBe(1);
    expect(client.match(/\bworkflowSheetClass\)?\}/g)?.length).toBe(6);
    const payment = client.slice(client.indexOf("<Dialog open={paymentDialogOpen}"), client.indexOf("<Dialog open={customerPreviewOpen}"));
    expect(payment).toContain("bg-surface text-text-primary dark:border-border-color-2 dark:bg-surface dark:text-text-primary");
    expect(payment).not.toMatch(/\bpaper-/);
    // Emit, detail, edit, item and payment workflows: no paper-only colors before the customer preview.
    const workflows = client.slice(client.indexOf('<DialogContent className="max-w-5xl flex'), client.indexOf("<Dialog open={customerPreviewOpen}"));
    expect(workflows).toContain("EDITAR FACTURA");
    expect(workflows).not.toMatch(/\b(?:bg|text|border|divide|ring)-paper-/);
    expect(client).toContain("const workflowInputClass = inputClass");
    expect(client).toContain("const workflowPanelClass");
    expect(client).toContain("const workflowFooterClass");
    expect(client).not.toContain("rgba(255,255,255");
    expect(client).toContain('<MoneyInput className={workflowInputClass}');
    expect(client).toContain('onValueChange={(amount) => setSplitDrafts');
  });
});
