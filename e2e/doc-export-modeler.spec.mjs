// End-to-end coverage for the Documentation panel in the Modeler toolbar
// (api/web/editor.js, ADR-0138). Driven through the real vendored bpmn-js and the
// real editor: publishing a version, reading the history back, and sharing and
// revoking a version's public link — the whole surface of "give this process to
// a wider audience".
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.__errors = errors;
  await page.goto("/doc-export-modeler-harness.html");
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await page.evaluate(() => window.__mount());
});

test.afterEach(async ({ page }) => {
  expect(page.__errors, "no uncaught page errors").toEqual([]);
});

test("the panel opens with the process name and an empty history", async ({ page }) => {
  await expect(page.locator("#doc-panel")).toBeHidden();
  await page.locator("#docexport").click();

  await expect(page.locator("#doc-panel")).toBeVisible();
  // The title is prefilled from the model, so the common case is one click.
  await expect(page.locator("#doc-title")).toHaveValue("Reisebuchung");
  await expect(page.locator("#doc-history")).toContainText("No version published yet.");

  // The button toggles the panel shut again.
  await page.locator("#docexport").click();
  await expect(page.locator("#doc-panel")).toBeHidden();
});

test("publishing produces a numbered version carrying the model's prose", async ({ page }) => {
  await page.locator("#docexport").click();
  await page.locator("#doc-note").fill("Freigabe Q3");
  await page.locator("#doc-publish").click();

  await expect(page.locator(".doc-version")).toHaveCount(1);
  await expect(page.locator(".doc-version").first()).toContainText("v1");
  await expect(page.locator(".doc-version").first()).toContainText("Freigabe Q3");

  // What was uploaded is a real document, with the element prose and the source
  // beside it — the panel is not just posting a filename.
  const upload = await page.evaluate(() => {
    const u = window.__uploads.at(-1);
    return {
      title: u.title, note: u.note,
      annotated: u.elements.find((e) => e.annotations.length > 0),
      documented: u.elements.find((e) => e.documentation),
      hasXML: u.xml.includes("textAnnotation"),
      pdfHead: atob(u.pdfBase64).slice(0, 5),
      pdfBytes: atob(u.pdfBase64).length,
    };
  });
  expect(upload.title).toBe("Reisebuchung");
  expect(upload.note).toBe("Freigabe Q3");
  expect(upload.annotated.annotations).toEqual(["Benötigt IATA-Zugang"]);
  expect(upload.documented.documentation).toBe("Ruft das Buchungssystem der Airline auf.");
  expect(upload.hasXML).toBe(true);
  expect(upload.pdfHead).toBe("%PDF-");
  expect(upload.pdfBytes).toBeGreaterThan(5000);

  // The note is cleared after publishing, so the next version does not silently
  // inherit the last one's reason.
  await expect(page.locator("#doc-note")).toHaveValue("");
});

test("a second publish adds a version above the first", async ({ page }) => {
  await page.locator("#docexport").click();
  await page.locator("#doc-publish").click();
  await expect(page.locator(".doc-version")).toHaveCount(1);
  await page.locator("#doc-note").fill("Nach dem Review");
  await page.locator("#doc-publish").click();
  await expect(page.locator(".doc-version")).toHaveCount(2);

  // Newest first: the history reads as a history.
  await expect(page.locator(".doc-version").first()).toContainText("v2");
  await expect(page.locator(".doc-version").nth(1)).toContainText("v1");

  // The older version is untouched by the new one — that is what historization
  // is for.
  await expect(page.locator(".doc-version").nth(1)).not.toContainText("Nach dem Review");
});

test("a version is private until shared, and revoking takes the link away", async ({ page }) => {
  await page.locator("#docexport").click();
  await page.locator("#doc-publish").click();
  await expect(page.locator(".doc-version")).toHaveCount(1);

  // Private by default: a download for whoever is signed in, no public link.
  await expect(page.locator(".doc-version a", { hasText: "Open PDF" })).toBeVisible();
  await expect(page.locator(".doc-version a", { hasText: "Public link" })).toHaveCount(0);

  await page.locator("[data-share]").click();
  const link = page.locator(".doc-version a", { hasText: "Public link" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "/public/process-docs/tok1");
  // The link opens away from the editor, and carries no referrer to the host.
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener");

  await page.locator("[data-unshare]").click();
  await expect(page.locator(".doc-version a", { hasText: "Public link" })).toHaveCount(0);
  await expect(page.locator("[data-share]")).toBeVisible();
});

test("sharing is per version: publishing v2 does not expose v1", async ({ page }) => {
  await page.locator("#docexport").click();
  await page.locator("#doc-publish").click();
  await page.locator("#doc-publish").click();
  await expect(page.locator(".doc-version")).toHaveCount(2);

  // Share only the newest.
  await page.locator(".doc-version").first().locator("[data-share]").click();
  await expect(page.locator(".doc-version").first().locator("a", { hasText: "Public link" })).toBeVisible();

  // The older one stayed private. A reader handed the new link cannot reach it.
  await expect(page.locator(".doc-version").nth(1).locator("a", { hasText: "Public link" })).toHaveCount(0);
  await expect(page.locator(".doc-version").nth(1).locator("[data-share]")).toBeVisible();
});

test("a failure is reported in the panel rather than silently swallowed", async ({ page }) => {
  await page.locator("#docexport").click();
  await page.locator("#doc-publish").click();
  await expect(page.locator(".doc-version")).toHaveCount(1);

  // Make the share route fail the way a revoked session or a store fault would.
  await page.evaluate(() => {
    const version = window.__versions[0];
    version.id = "gone"; // the row still names the old id, so the share 404s
  });
  await page.locator("[data-share]").click();

  await expect(page.locator("#doc-err")).toContainText("no documentation version with that id");
  // And the control comes back, so the user can retry rather than being stuck.
  await expect(page.locator("[data-share]")).toBeEnabled();
});
