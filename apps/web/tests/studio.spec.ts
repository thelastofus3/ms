import { test, expect } from "@playwright/test";

test("approval follows the successfully displayed job, not a demo", async ({
  page,
}) => {
  const manifest = await (await page.request.get("/demo/manifest.json")).json();
  const model = await (await page.request.get("/demo/avatar.glb")).body();
  const job = {
    id: "preview-test",
    avatar_id: manifest.avatar_id,
    version: manifest.version,
    status: "SUCCEEDED",
    approved: false,
  };
  await page.route("**/v1/avatar-jobs", (route) =>
    route.fulfill({ json: { ...job, status: "QUEUED" } }),
  );
  await page.route("**/v1/avatar-jobs/preview-test", (route) =>
    route.fulfill({ json: job }),
  );
  await page.route("**/v1/avatars/**/versions/1", (route) =>
    route.fulfill({ json: manifest }),
  );
  await page.route("**/v1/avatars/**/versions/1/model", (route) =>
    route.fulfill({ body: model, contentType: "model/gltf-binary" }),
  );
  await page.goto("/?mode=mesh");
  await page.getByLabel("Токен доступа").fill("test-only");
  await page.getByRole("button", { name: "Создать аватара →" }).click();
  await expect(page.getByText("Модель загружена")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Подтвердить внешность" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Открыть демо" }).click();
  await expect(
    page.getByRole("button", { name: "Подтвердить внешность" }),
  ).toBeDisabled();
});

test("a slow superseded renderer load cannot become the displayed result", async ({
  page,
}) => {
  await page.goto("/?mode=mesh");
  const result = await page.evaluate(async () => {
    const path = "/src/avatar/renderer.ts";
    const { AvatarRenderer } = await import(path);
    const manifest = await (await fetch("/demo/manifest.json")).json(),
      bytes = await (await fetch("/demo/avatar.glb")).arrayBuffer();
    const host = document.createElement("div");
    host.style.cssText = "width:400px;height:400px";
    document.body.appendChild(host);
    const view = new AvatarRenderer(host),
      original = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    crypto.subtle.digest = async (
      ...args: Parameters<typeof crypto.subtle.digest>
    ) => {
      if (first) {
        first = false;
        await gate;
      }
      return original(...args);
    };
    try {
      const old = view.load(manifest, bytes.slice(0));
      const current = await view.load(manifest, bytes.slice(0));
      release();
      return {
        oldWasDiscarded: (await old) === undefined,
        currentLoaded: !!current,
      };
    } finally {
      crypto.subtle.digest = original;
      view.dispose();
      host.remove();
    }
  });
  expect(result).toEqual({ oldWasDiscarded: true, currentLoaded: true });
});

test("two real avatar instances keep separate skeletons and clean up canvases", async ({
  page,
}) => {
  await page.goto("/?mode=mesh");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/avatar/renderer.ts";
    const { AvatarRenderer } = await import(modulePath);
    const manifest = await (await fetch("/demo/manifest.json")).json();
    const bytes = await (await fetch("/demo/avatar.glb")).arrayBuffer();
    const elements = [
      document.createElement("div"),
      document.createElement("div"),
    ];
    for (const element of elements) {
      element.style.cssText = "width:400px;height:400px";
      document.body.appendChild(element);
    }
    const a = new AvatarRenderer(elements[0]),
      b = new AvatarRenderer(elements[1]);
    const [bounds] = await Promise.all([
      a.load(manifest, bytes.slice(0)),
      b.load(manifest, bytes.slice(0)),
    ]);
    a.controller.setSource("camera");
    b.controller.setSource("camera");
    a.controller.receive(
      {
        sequence: 1,
        timestamp_ms: 1,
        position: [2, 0, 3],
        rotation: [0, 0, 0, 1],
        joints: { head: [0, 0.38268343, 0, 0.92387953] },
        confidence: 1,
        tracking_state: "TRACKED",
      },
      100,
    );
    a.controller.update(0.1, 101);
    b.controller.update(0.1, 101);
    const distinct =
      a.controller.rig.bindings.head.bone !==
      b.controller.rig.bindings.head.bone;
    const positions = [
      a.controller.root.position.x,
      b.controller.root.position.x,
    ];
    const headChanged = !a.controller.rig.bindings.head.bone.quaternion.equals(
      b.controller.rig.bindings.head.bone.quaternion,
    );
    a.dispose();
    b.dispose();
    const canvases = elements.reduce(
      (count, el) => count + el.querySelectorAll("canvas").length,
      0,
    );
    elements.forEach((el) => el.remove());
    return {
      distinct,
      positions,
      headChanged,
      canvases,
      height: bounds.height,
      minimumY: bounds.minimumY,
    };
  });
  expect(result.distinct).toBe(true);
  expect(result.positions).toEqual([2, 0]);
  expect(result.headChanged).toBe(true);
  expect(result.canvases).toBe(0);
  expect(result.height).toBeGreaterThan(1.79);
  expect(result.height).toBeLessThan(1.86);
  expect(Math.abs(result.minimumY)).toBeLessThan(0.02);
});
test("real MPFB package loads in the browser and controls switch", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?mode=mesh");
  await page.getByRole("button", { name: "Открыть демо" }).click();
  await expect(page.getByText("Модель загружена")).toBeVisible();
  await expect(page.getByText(/19 костей/)).toBeVisible();
  await page.getByRole("button", { name: "Тест позы" }).click();
  await expect(page.getByText("Источник: тестовая поза")).toBeVisible();
  await page.screenshot({ path: "../../.runtime/avatar-browser.png" });
  await page.getByRole("button", { name: "Клавиатура" }).click();
  await expect(page.getByText("Источник: клавиатура")).toBeVisible();
  expect(errors).toEqual([]);
});

test("operator creates an avatar through the real API and worker", async ({
  page,
}) => {
  test.skip(!process.env.AVATAR_E2E_TOKEN, "Requires running API and worker");
  test.setTimeout(90000);
  await page.goto("/?mode=mesh");
  await page.getByLabel("Токен доступа").fill(process.env.AVATAR_E2E_TOKEN!);
  await page.getByLabel("Имя", { exact: true }).fill("Browser integration");
  await page.getByRole("button", { name: "Создать аватара →" }).click();
  await expect(page.getByText("Модель загружена")).toBeVisible({
    timeout: 60000,
  });
  await page.getByRole("button", { name: "Открыть демо" }).click();
  await expect(
    page.getByRole("button", { name: "Подтвердить внешность" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Показать результат задания" })
    .click();
  await expect(
    page.getByRole("button", { name: "Подтвердить внешность" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Подтвердить внешность" }).click();
  await expect(
    page.getByRole("button", { name: "Внешность подтверждена" }),
  ).toBeDisabled();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать пакет" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^avatar-.*\.zip$/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "../../.runtime/avatar-studio-full.png",
    fullPage: true,
  });
});
