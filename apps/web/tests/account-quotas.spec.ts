import { expect, test, type Page } from "@playwright/test";
import { testAccount } from "./auth-fixture";

const limits = { storageLimitBytes: 20 * 1024 ** 3, pendingUploadLimit: 3, activeJobLimit: 2 };
const account = { ...testAccount, role: "ADMIN" };
const usage = {
  ...limits, storageChargedBytes: 2 * 1024 ** 3, storageConfirmedBytes: 1024 ** 3, pendingUploads: 1, activeJobs: 1,
  uploads: [
    { id: "paused", kind: "splat", sealed: false, createdAt: "2026-10-11T10:00:00Z", expiresAt: "2026-10-12T10:00:00Z", discardedAt: null, discardable: true },
    { id: "legacy", kind: "capture", sealed: true, createdAt: "2026-10-10T10:00:00Z", expiresAt: null, discardedAt: null, discardable: false },
  ],
};
async function service(page: Page, options: { discardRejected?: boolean; patchRejected?: boolean; queued?: boolean } = {}) {
  let current = structuredClone(usage), effective = { ...limits };
  let jobs = options.queued ? [{ id: "queued", kind: "capture", name: "Waiting room", state: "QUEUED", stage: "preprocessing", progress: 0, profile: "local", error: null, cancel_requested: false, diagnostics: {} }] : [];
  const mutations: { path: string; body: unknown }[] = [];
  await page.route("**/v1/rooms/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: account });
    if (path.endsWith("/auth/users")) return route.fulfill({ json: [account] });
    if (path.endsWith(`/auth/users/${account.id}/quota`)) {
      if (request.method() === "PATCH") {
        mutations.push({ path, body: request.postDataJSON() });
        if (options.patchRejected) return route.fulfill({ status: 409, json: { message: "Limits could not be saved. Retry shortly." } });
        effective = { ...effective, ...request.postDataJSON() };
      }
      return route.fulfill({ json: effective });
    }
    if (path.endsWith("/quota")) return route.fulfill({ json: current });
    if (path.endsWith("/uploads/paused") && request.method() === "DELETE") {
      mutations.push({ path, body: null });
      if (options.discardRejected) return route.fulfill({ status: 409, json: { message: "This upload is now attached to a job and cannot be discarded." } });
      current = { ...current, pendingUploads: 0, uploads: current.uploads.filter(upload => upload.id !== "paused") };
      return route.fulfill({ status: 202, json: { id: "paused", discarded: true } });
    }
    if (path.endsWith("/jobs/queued/cancel")) {
      jobs = jobs.map(job => ({ ...job, state: "CANCELLED", cancel_requested: true })); current = { ...current, activeJobs: 0 };
      return route.fulfill({ json: jobs[0] });
    }
    if (path.endsWith("/jobs")) return route.fulfill({ json: jobs });
    return route.fulfill({ status: 404, json: { message: "Unexpected test request" } });
  });
  return mutations;
}

test("library displays reserved usage and only permits discarding eligible uploads", async ({ page }) => {
  const mutations = await service(page);
  await page.goto("/#rooms");
  await page.getByRole("button", { name: "Room library", exact: true }).click();
  const quota = page.getByRole("region", { name: "Room account allowance" });
  await expect(quota).toContainText("2 GiB / 20 GiB");
  await expect(quota).toContainText("Pending uploads: 1 / 3");
  await expect(quota).toContainText("Active jobs: 1 / 2");
  await expect(quota).toContainText("Expires");
  await expect(quota.getByRole("button", { name: "Discard upload" })).toHaveCount(1);
  await quota.getByRole("button", { name: "Discard upload" }).click();
  await expect(quota).toContainText("Pending uploads: 0 / 3");
  expect(mutations).toEqual([{ path: "/v1/rooms/uploads/paused", body: null }]);
});

test("administrator limits form validates and saves independently without changing the session", async ({ page }) => {
  const mutations = await service(page);
  await page.goto("/#admin");
  const form = page.getByRole("form", { name: "Quota limits for tester" });
  await expect(form.getByLabel("Storage limit (GiB)")).toHaveValue("20");
  await form.getByLabel("Pending upload limit").fill("0");
  await form.getByRole("button", { name: "Save limits" }).click();
  expect(mutations).toHaveLength(0);
  await form.getByLabel("Pending upload limit").fill("4");
  await form.getByLabel("Active job limit").fill("3");
  await form.getByLabel("Storage limit (GiB)").fill("25");
  await form.getByRole("button", { name: "Save limits" }).click();
  await expect(form.getByRole("status")).toContainText("Limits saved");
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
  await expect(page.getByRole("form", { name: "Edit tester" })).toBeVisible();
  expect(mutations).toEqual([{ path: `/v1/rooms/auth/users/${account.id}/quota`, body: { storageLimitBytes: 25 * 1024 ** 3, pendingUploadLimit: 4, activeJobLimit: 3 } }]);
});

test("allowance and upload controls fit a narrow screen", async ({ page }) => {
  await service(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#rooms");
  await expect(page.getByRole("region", { name: "Room account allowance" })).toBeVisible();
  await page.getByRole("button", { name: "Import PLY", exact: true }).click();
  await expect(page.getByLabel("Gaussian PLY file")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("navigation", { name: "Room workspace" }).getByRole("button", { name: "+ New capture", exact: true }).click();
  await expect(page.getByLabel("Photos or video")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "../../.runtime/account-quotas/frontend-room-narrow.png", fullPage: true });
});

test("a rejected discard retains usage and its explanation while allowance polling continues", async ({ page }) => {
  await service(page, { discardRejected: true });
  await page.goto("/#rooms");
  const quota = page.getByRole("region", { name: "Room account allowance" });
  await quota.getByRole("button", { name: "Discard upload" }).click();
  await expect(quota.getByRole("alert")).toContainText("now attached to a job");
  await expect(quota).toContainText("Pending uploads: 1 / 3");
  await page.waitForResponse(response => new URL(response.url()).pathname === "/v1/rooms/quota");
  await expect(quota.getByRole("alert")).toContainText("now attached to a job");
});

test("cancelling a queued job refreshes the active allowance", async ({ page }) => {
  await service(page, { queued: true });
  await page.goto("/#rooms");
  const quota = page.getByRole("region", { name: "Room account allowance" });
  await expect(quota).toContainText("Active jobs: 1 / 2");
  await page.getByRole("button", { name: "Cancel reconstruction" }).click();
  await expect(quota).toContainText("Active jobs: 0 / 2");
  await expect(page.getByRole("button", { name: "Cancel reconstruction" })).toHaveCount(0);
});

test("administrator quota errors preserve edited values and forms fit a narrow screen", async ({ page }) => {
  await service(page, { patchRejected: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#admin");
  const form = page.getByRole("form", { name: "Quota limits for tester" });
  await form.getByLabel("Storage limit (GiB)").fill("25");
  await form.getByRole("button", { name: "Save limits" }).click();
  await expect(form.getByRole("alert")).toContainText("Limits could not be saved");
  await expect(form.getByLabel("Storage limit (GiB)")).toHaveValue("25");
  expect(await page.locator("form form").count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "../../.runtime/account-quotas/frontend-admin-narrow.png", fullPage: true });
});
