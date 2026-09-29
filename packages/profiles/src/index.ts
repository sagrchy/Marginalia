import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../styles");
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8").trim();

/** Preset subjects and their tutor styles (Markdown the tutor reads directly). */
export const PRESET_SUBJECTS: { name: string; slug: string; tutorStyle: string }[] = [
  { name: "Analysis", slug: "analysis", tutorStyle: read("analysis.md") },
  { name: "Neuroscience", slug: "neuroscience", tutorStyle: read("neuroscience.md") },
  { name: "Philosophy", slug: "philosophy", tutorStyle: read("philosophy.md") },
  { name: "Systems", slug: "systems", tutorStyle: read("systems.md") },
];

/** Style given to new subjects. */
export const DEFAULT_TUTOR_STYLE = read("general.md");
