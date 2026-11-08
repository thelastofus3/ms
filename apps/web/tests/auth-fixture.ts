import type { Page } from "@playwright/test";
export const testQuotaLimits = { storageLimitBytes: 21474836480, pendingUploadLimit: 3, activeJobLimit: 2 };
export const testQuota = { ...testQuotaLimits, storageChargedBytes: 0, storageConfirmedBytes: 0, pendingUploads: 0, activeJobs: 0, uploads: [] };
export const testAccount = { id: "test-account", username: "tester", role: "RECONSTRUCTOR", disabled: false };
export const testAccessToken = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LWFjY291bnQifQ.c2lnbmF0dXJl";
export const loginResponse = (account = testAccount) => ({ account, accessToken: testAccessToken, tokenType: "Bearer", expiresIn: 86400 });
export async function authenticated(page: Page) {
  await page.route("**/v1/rooms/auth/me", route => route.fulfill({ json: testAccount }));
}
