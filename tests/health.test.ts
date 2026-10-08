import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/health/route";

describe("GET /api/v1/health", () => {
  it("responde el envelope de éxito con status ok", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { status: "ok" },
    });
  });
});
