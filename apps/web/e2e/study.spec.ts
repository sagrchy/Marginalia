import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "../../../fixtures");

async function importPdf(page: Page, file: string, subject: string) {
  await page.goto("/#/");
  await page.getByTestId("import-input").setInputFiles(path.join(FIXTURES, file));
  const dialog = page.getByRole("dialog", { name: "Import PDF" });
  await dialog.getByLabel("Subject").selectOption({ label: subject });
  await dialog.getByRole("button", { name: "Import" }).click();
}

const bookIdFromUrl = (page: Page) => Number(page.url().match(/#\/(?:read|book)\/(\d+)/)![1]);

test.describe.serial("Marginalia v2", () => {
  let bookId = 0;

  test("imports a PDF into a subject and refuses duplicates", async ({ page }) => {
    await importPdf(page, "calculus-sample.pdf", "Analysis");
    await expect(page.getByText(/Added “/)).toBeVisible();
    const card = page.getByTestId("book-card").filter({ hasText: /Calculus/ });
    await expect(card).toBeVisible();
    await expect(card).not.toContainText("Preparing", { timeout: 30_000 });

    await importPdf(page, "calculus-sample.pdf", "Analysis");
    await expect(page.getByText(/already in your library/)).toBeVisible();
    await page.getByRole("button", { name: "Close" }).first().click();
  });

  test("book page: start a named session with a goal, then read with Claude", async ({ page }) => {
    await page.goto("/#/");
    await page.getByTestId("book-card").filter({ hasText: /Calculus/ }).getByRole("button", { name: /Calculus.* options/ }).click();
    await page.getByRole("menuitem", { name: "Sessions & details" }).click();
    bookId = bookIdFromUrl(page);

    await page.getByRole("button", { name: "New session" }).click();
    await page.getByLabel("Name").fill("Continuity");
    await page.getByLabel(/^Goal/).fill("understand ε–δ");
    await page.getByRole("radio", { name: "Problem solving" }).click();
    await page.getByRole("radio", { name: "25 min" }).click();
    await page.getByRole("button", { name: "Start" }).click();

    await expect(page).toHaveURL(/#\/read\/\d+\?session=\d+/);
    await expect(page.locator(".page canvas").first()).toBeVisible();
    await expect(page.locator(".session-chip")).toContainText("Continuity");
    await expect(page.locator(".claude-head")).toContainText("Problem solving");

    // Ask; the reply streams with what Claude looked at, and page references are links.
    const composer = page.getByLabel("Message Claude");
    await composer.fill("What is going on here?");
    await composer.press("Enter");
    const reply = page.locator(".msg.assistant").last();
    await expect(reply).toContainText("here's the idea in plain terms");
    await expect(reply.locator(".activity")).toContainText("Reading p.");
    await expect(reply.locator(".page-ref").first()).toBeVisible();
    await expect(page.locator(".msg.user").last()).toContainText("What is going on here?");
    await expect(page.locator(".usage-line")).toBeVisible();

    // Claude may only *suggest* memories; nothing is saved until approved.
    await composer.fill("Please remember that I like examples first");
    await composer.press("Enter");
    const card = page.locator(".memory-card");
    await expect(card).toContainText("concrete example");
    await card.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/Saved to memory/)).toBeVisible();
  });

  test("errors keep your message so you can retry", async ({ page }) => {
    await page.goto(`/#/book/${bookId}`);
    await page.getByRole("button", { name: "Continue" }).first().click();
    const composer = page.getByLabel("Message Claude");
    await composer.fill("hello [[fail:limit]]");
    await composer.press("Enter");
    await expect(page.locator(".msg-error")).toContainText("limit");
    await expect(composer).toHaveValue("hello [[fail:limit]]");
  });

  test("highlight a selection, find it in the sidebar, delete and undo", async ({ page }) => {
    await page.goto(`/#/read/${bookId}`);
    const span = page.locator(".page[data-page-number='1'] .textLayer span").filter({ hasText: /\w{4,}/ }).first();
    await expect(span).toBeVisible();
    const box = (await span.boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const toolbar = page.getByRole("toolbar", { name: "Selection" });
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "Highlight green" }).click();
    await expect(page.locator(".hl-layer .hl.hl-green").first()).toBeVisible();

    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await page.getByRole("tab", { name: /Highlights/ }).click();
    await expect(page.locator(".side-hl")).toHaveCount(1);
    await page.locator(".side-hl").hover();
    await page.getByRole("button", { name: "Delete highlight" }).click();
    await expect(page.locator(".side-hl")).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".side-hl")).toHaveCount(1);

    // Notes stay with the book.
    await page.getByRole("tab", { name: /Notes/ }).click();
    await page.getByRole("button", { name: "Note" }).click();
    await page.locator(".note-edit textarea").fill("Check the definition again");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".side-note")).toContainText("Check the definition again");
  });

  test("page box, find and keyboard panels", async ({ page }) => {
    await page.goto(`/#/read/${bookId}`);
    await expect(page.locator(".page canvas").first()).toBeVisible();
    const box = page.getByLabel("Page", { exact: true });
    await box.fill("3");
    await box.press("Enter");
    await expect(page.locator(".back-pill")).toContainText("Back to p.");
    await expect(box).toHaveValue(/3|iii/);

    await page.locator(".pdf-container").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Find in book" }).fill("continuous");
    await expect(page.locator(".find-count")).toContainText(/of \d+/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("textbox", { name: "Find in book" })).toHaveCount(0);

    const claude = page.locator("aside.claude");
    const visible = await claude.isVisible();
    await page.keyboard.press("]");
    await expect(claude).toBeVisible({ visible: !visible });
    await page.keyboard.press("]");
    await expect(claude).toBeVisible({ visible });
  });

  test("ending a session writes a summary that shows on the book page", async ({ page }) => {
    await page.goto(`/#/book/${bookId}`);
    await page.getByRole("button", { name: "Continue" }).first().click();
    await page.getByRole("button", { name: "End", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Session ended" });
    await expect(dialog).toContainText("Worked through the section on continuity");
    await dialog.getByRole("button", { name: "Back to sessions" }).click();
    const s = page.locator("article.session", { hasText: "Continuity" });
    await expect(s).toContainText("Reopen");
    await s.getByRole("button", { name: "Show summary" }).click();
    await expect(s).toContainText("Next time");
  });

  test("settings: memory, study calendar, themes", async ({ page }) => {
    await page.goto("/#/settings/memory");
    await expect(page.locator(".mem", { hasText: "concrete example" })).toBeVisible();
    await expect(page.locator(".mem", { hasText: "quantifiers" })).toContainText("Approve"); // proposed at session end

    await page.goto("/#/settings/study");
    await expect(page.locator(".heat .cell").first()).toBeVisible();

    await page.goto("/#/settings/appearance");
    await page.getByRole("button", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "Paper" }).click();
  });

  test("rename, then delete a book with undo", async ({ page }) => {
    await page.goto("/#/");
    const card = page.getByTestId("book-card").filter({ hasText: /Calculus/ });
    await card.getByRole("button", { name: /options$/ }).click();
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Title").fill("Calculus (sample)");
    await dialog.getByRole("button", { name: "Save" }).click();
    const renamed = page.getByTestId("book-card").filter({ hasText: "Calculus (sample)" });
    await expect(renamed).toBeVisible();

    await renamed.getByRole("button", { name: /options$/ }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: /Delete/ }).click();
    await expect(renamed).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByTestId("book-card").filter({ hasText: "Calculus (sample)" })).toBeVisible();
  });
});
