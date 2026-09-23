import { expect, test } from "@playwright/test";

/** API pública y puerta 401 sin sesión. */
test("health pública responde ok @full", async ({ request }) => {
  const response = await request.get("/api/v1/health");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(body.data.status).toBe("ok");
});

test("api protegida sin sesión devuelve 401 @full", async ({ request }) => {
  const response = await request.get("/api/v1/products");
  expect(response.status()).toBe(401);
  const body = await response.json();
  expect(body.success).toBe(false);
  expect(body.code).toBe("UNAUTHENTICATED");
});

