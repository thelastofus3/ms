import { test, expect } from "@playwright/test";

test("photographic app has no legacy entry and stores personal photos honestly", async ({
  page,
}) => {
  await page.goto("/?mode=mesh");
  await page.route("**/v1/photo-captures", async (route) => {
    if (route.request().method() === "GET")
      await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await expect(
    page.getByRole("heading", { name: "Фотографический аватар" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Скелетный прототип" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Мои фотографии" }).click();
  await expect(
    page.getByText("Создание аватара пока недоступно", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Фотографии человека").setInputFiles({
    name: "test.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9Y0AAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(
    page.getByRole("button", { name: "Сохранить фотографии" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Сохранить фотографии" }).click();
  await expect(page.getByText("Фото сохранены", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Мои фотографии" }).click();
  await expect(page.getByText("Фото сохранены", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Удалить набор" }).click();
  await expect(page.getByText("Сохранённых наборов пока нет.")).toBeVisible();
  await page.screenshot({
    path: "../../.runtime/personal-photos-browser.png",
    fullPage: true,
  });
});
