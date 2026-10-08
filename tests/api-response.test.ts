import { describe, expect, it } from "vitest";
import { fail, ok } from "@/src/shared/lib/api-response";

describe("api-response envelopes", () => {
  it("ok() envuelve data con success:true", async () => {
    const response = ok({ status: "ok" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { status: "ok" },
    });
  });

  it("fail() envuelve code/message con success:false", async () => {
    const response = fail("NOT_FOUND", "No encontrado", 404);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      code: "NOT_FOUND",
      message: "No encontrado",
    });
  });
});
