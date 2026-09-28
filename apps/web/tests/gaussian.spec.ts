import { test, expect } from "@playwright/test";

test("photographic workspace loads real splats and articulates the person", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Фотографический аватар" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(
      async () => {
        const alert = page.getByRole("alert");
        if (await alert.count()) throw Error(await alert.innerText());
        return page.getByTestId("gaussian-status").innerText();
      },
      { timeout: 30_000 },
    )
    .toContain("531");
  await expect(page.getByTestId("gaussian-status")).toContainText("531", {
    timeout: 90_000,
  });
  await page.getByLabel("Движение").selectOption("canonical");
  await page.getByRole("button", { name: "Пауза" }).click();
  await page.waitForTimeout(1000);
  const before = await page
    .locator(".gaussian-view canvas")
    .screenshot({ path: "../../.runtime/gaussian-canonical-browser.png" });
  await page.getByLabel("Движение").selectOption("wave");
  await page.waitForTimeout(1000);
  const after = await page.locator(".gaussian-view canvas").screenshot();
  await page.screenshot({
    path: "../../.runtime/gaussian-browser.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  expect(Buffer.compare(before, after)).not.toBe(0);
  await page.waitForTimeout(500);
  const paused = await page.locator(".gaussian-view canvas").screenshot();
  expect(Buffer.compare(after, paused)).toBe(0);
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await page.waitForTimeout(500);
  const resumed = await page.locator(".gaussian-view canvas").screenshot();
  expect(Buffer.compare(paused, resumed)).not.toBe(0);
  await page
    .getByLabel("Открыть PLY / SPLAT")
    .setInputFiles("public/gaussian-demo/avatar.splat");
  await expect(page.getByTestId("gaussian-status")).toContainText(
    "статическая модель",
  );
  await expect(page.getByLabel("Движение")).toBeDisabled();
  await page.getByRole("button", { name: "Загрузить пример HUGS" }).click();
  await expect(page.getByLabel("Движение")).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Скелетный прототип" }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
