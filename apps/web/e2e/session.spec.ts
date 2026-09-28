import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "../../../fixtures");

async function importViaPicker(page: Page, file: string, subject: string) {
  await page.goto("/#/");
  await page.getByLabel("Import into subject").selectOption({ label: subject });
  await page.getByTestId("import-input").setInputFiles(path.join(FIXTURES, file));
  await expect(page.getByText(/Imported “/)).toBeVisible();
}

test.describe.serial("Marginalia end to end", () => {
  test("imports a PDF from the Front Page file picker (LIB-1/7)", async ({ page }) => {
    await importViaPicker(page, "calculus-sample.pdf", "Analysis");
    await expect(page.locator(".subject-block", { hasText: "Analysis" }).getByText("Calculus Sample")).toBeVisible();
    // Duplicate import is refused by hash.
    await page.getByTestId("import-input").setInputFiles(path.join(FIXTURES, "calculus-sample.pdf"));
    await expect(page.getByText(/already in the library/)).toBeVisible();
  });

  test("a full session can be run without the mouse (M3)", async ({ page }) => {
    await page.goto("/#/");
    await page.getByRole("link", { name: "Calculus Sample" }).first().click();
    await expect(page.locator(".page canvas").first()).toBeVisible();
    await expect(page.getByTestId("current-page")).toContainText("p. 1");

    // Everything below is keyboard only.
    const reader = page.locator("[data-reader-focus]");
    await reader.focus();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await page.keyboard.type("start a session");
    await page.keyboard.press("Enter");
    // Radio group is focused; choose Problem solving with the arrow key, then tab to the goal.
    await expect(page.locator("[data-start-session] input:checked")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Tab");
    await page.keyboard.type("finish 7.2 exercises");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Welcome back")).toBeVisible();
    await expect(page.locator(".room-header")).toContainText("Problem solving");
    await expect(page.locator(".statusbar")).toContainText("finish 7.2 exercises");

    // Move to p. 3 and ask for a hint with a single key in the reader.
    await reader.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("current-page")).toContainText("p. 3");
    await page.waitForTimeout(1700); // dwell long enough to be logged
    await reader.focus();
    await page.keyboard.press("h");
    await expect(page.locator(".tutor-article").filter({ hasText: "hints-first reply" }).first()).toBeVisible();
    await expect(page.locator(".tutor-article").filter({ hasText: "hints-first reply" }).first()).toContainText("p. 3");
    await expect(page.locator(".statusbar")).toContainText(/usage ~\d/);

    // Explain via E; Summarize via S uses the fast model.
    await reader.focus();
    await page.keyboard.press("s");
    await expect(page.locator(".tutor-article .dateline").filter({ hasText: "claude-haiku-4-5-20251001" }).first()).toBeVisible();

    // Type a question in the tutor and send with Ctrl+Enter.
    await reader.focus();
    await page.keyboard.press("a");
    await expect(page.locator("textarea[data-tutor-input]")).toBeFocused();
    await page.keyboard.type("Why can delta depend on x here?");
    await page.keyboard.press("Control+Enter");
    await expect(page.locator(".pullquote").filter({ hasText: "Why can delta depend on x here?" })).toBeVisible();
    await expect(page.locator(".tutor-article")).toHaveCount(4); // opening + 3 replies

    // Park a question with Q.
    await page.keyboard.press("Escape");
    await expect(reader).toBeFocused();
    await page.keyboard.press("q");
    await expect(page.getByLabel("Question to park")).toBeFocused();
    await page.keyboard.type("Why does a closed interval matter?");
    await page.keyboard.press("Enter");
    await expect(page.locator(".statusbar")).toContainText("1 parked Q");

    // Layout presets and focus mode by key.
    await reader.focus();
    await page.keyboard.press("3");
    await expect(page.getByText("Layout: Review")).toBeVisible();
    await reader.focus();
    await page.keyboard.press("f");
    await expect(page.locator(".focus-strip")).toBeVisible();
    await reader.focus();
    await page.keyboard.press("f");
    await expect(page.locator(".focus-strip")).toHaveCount(0);

    // Close the session and accept the debrief.
    await reader.focus();
    await page.keyboard.press("Control+.");
    await expect(page).toHaveURL(/#\/report\/\d+/);
    await expect(page.getByRole("heading", { name: "Concepts" })).toBeVisible();
    await expect(page.getByText("Nothing is saved to your learner model until you accept.")).toBeVisible();
    await page.keyboard.press("Control+Enter");
    await expect(page.getByText(/Saved: 2 concept update/)).toBeVisible();

    // The Front Page reflects the accepted debrief.
    await page.goto("/#/");
    await expect(page.locator(".col", { hasText: "Shaky concepts" })).toContainText("uniform continuity");
    await expect(page.locator(".col", { hasText: "Open questions" })).toContainText("Why does a closed interval matter?");
  });

  test("the next session's opening references the last debrief (M2)", async ({ page, request }) => {
    const lib = await (await request.get("/api/library")).json();
    const book = lib.find((s: any) => s.slug === "analysis").books[0];
    await request.patch("/api/settings", { data: { leanMode: true } });
    await page.goto(`/#/read/${book.id}`);
    await page.locator("[data-reader-focus]").focus();
    await page.keyboard.press("Control+k");
    await page.keyboard.type("start a session");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-start-session] input:checked")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".tutor-article.opening")).toContainText("Planned next: Problems 7.4 and 7.9");
    await expect(page.locator(".statusbar")).toContainText("LEAN on");
    await request.patch("/api/settings", { data: { leanMode: false } });
  });

  test("limit errors keep the draft and offer one-click retry (MU-6)", async ({ page }) => {
    const input = page.locator("textarea[data-tutor-input]");
    const lib = await (await page.request.get("/api/library")).json();
    await page.goto(`/#/read/${lib.find((s: any) => s.slug === "analysis").books[0].id}`);
    await input.click();
    await input.fill("[[fail:limit]] explain this");
    await page.keyboard.press("Control+Enter");
    await expect(page.locator(".tutor [role=alert]")).toContainText("Limit reached");
    await expect(input).toHaveValue("[[fail:limit]] explain this");
    // The reader keeps working while the tutor is unavailable.
    await page.locator("[data-reader-focus]").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("current-page")).not.toContainText("p. 1 ");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".tutor [role=alert]")).toContainText("Limit reached"); // the marker is still in the text
    await input.fill("explain this");
    await page.keyboard.press("Control+Enter");
    await expect(page.locator(".tutor-article").filter({ hasText: "reply from" }).last()).toBeVisible();
    await expect(page.locator(".tutor [role=alert]")).toHaveCount(0);
  });

  test("highlight with the mouse, attach a note, and pin a reply (RD-2, RD-5)", async ({ page }) => {
    const lib = await (await page.request.get("/api/library")).json();
    await page.goto(`/#/read/${lib.find((s: any) => s.slug === "analysis").books[0].id}`);
    await page.locator("[data-reader-focus]").focus();
    await page.keyboard.press("Control+Home");
    const span = page.locator('.page[data-page="0"] .textLayer span', { hasText: "The order of the quantifiers" }).first();
    await expect(span).toBeVisible();
    const box = (await span.boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator(".sel-pop")).toBeVisible();
    await page.locator(".sel-pop").getByRole("button", { name: /underline/ }).click();
    await expect(page.locator('.page[data-page="0"] .annot.underline').first()).toBeVisible();
    // Attach a note by clicking the highlight.
    const u = (await page.locator('.page[data-page="0"] .annot.underline').first().boundingBox())!;
    await page.mouse.click(u.x + u.width / 2, u.y + u.height / 2);
    await page.locator(".annot-note textarea").fill("Quantifier order: ∀ε ∃δ.");
    await page.locator(".annot-note").getByRole("button", { name: "Save note" }).click();
    await expect(page.locator('.page[data-page="0"] .annot.underline.has-note').first()).toBeVisible();
    // Pin the last tutor reply as marginalia.
    await page.locator(".tutor-article .msg-actions").last().getByRole("button", { name: "Pin to page" }).click();
    await expect(page.locator(".pin").first()).toBeVisible();
  });

  test("scanned PDFs are read by the vision engine on first visit and cached (LIB-4)", async ({ page }) => {
    await importViaPicker(page, "scanned-sample.pdf", "Neuroscience");
    const lib = await (await page.request.get("/api/library")).json();
    const book = lib.find((s: any) => s.slug === "neuroscience").books[0];
    expect(book.pagesNeedingOcr).toBe(3);
    await page.goto(`/#/read/${book.id}`);
    await expect.poll(async () => (await (await page.request.get(`/api/books/${book.id}/pages/0`)).json()).textSource, { timeout: 15_000 }).toBe("vision");
    const p = await (await page.request.get(`/api/books/${book.id}/pages/0`)).json();
    expect(p.text).toContain("continuous");
  });

  test("theme, settings test ping and the Subject Desk", async ({ page }) => {
    await page.goto("/#/settings");
    await page.getByText("Inverted print (dark)").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "inverted");
    await page.getByText("Print (light)").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "print");
    await page.locator(".role-row").first().getByRole("button", { name: "Test" }).click();
    await expect(page.locator(".test-out").first()).toContainText("ok · claude-sonnet-5");
    await page.goto("/#/");
    await page.locator(".subject-block").getByRole("link", { name: "Analysis" }).click();
    await expect(page.getByRole("heading", { name: "Analysis" })).toBeVisible();
    await expect(page.getByLabel("Persona")).toHaveValue(/Spivak/);
    await page.getByRole("button", { name: "Concepts" }).click();
    await expect(page.locator(".concepts-table")).toContainText("Believed every continuous function");
    await page.getByRole("button", { name: "Weekly targets" }).click();
    await page.getByLabel("sessions").fill("5");
    await page.getByLabel("sessions").blur();
    await page.goto("/#/");
    await expect(page.locator(".col", { hasText: "This week" })).toContainText("sessions");
  });

  test("review desk: generate, review, save and grade practice (PR-1..3)", async ({ page }) => {
    await page.goto("/#/review");
    await page.getByLabel("Source").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Draft items" }).click();
    await expect(page.getByText("Review before saving")).toBeVisible();
    await page.getByRole("button", { name: "Save to queue" }).click();
    await expect(page.locator(".card")).toBeVisible();
    await page.keyboard.press(" ");
    await expect(page.getByText("Model answer")).toBeVisible();
    await page.keyboard.press("3");
    await expect(page.locator(".masthead")).toContainText("1 reviewed this visit");
  });
});
