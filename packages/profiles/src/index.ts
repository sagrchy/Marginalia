import { ProfilePreset } from "@marginalia/shared";
import analysis from "../presets/analysis.json" with { type: "json" };
import neuroscience from "../presets/neuroscience.json" with { type: "json" };
import philosophy from "../presets/philosophy.json" with { type: "json" };
import systems from "../presets/systems.json" with { type: "json" };

/** Preset tutor profiles, validated. Adding a preset = one JSON file + one line here. */
export const PRESETS: ProfilePreset[] = [analysis, neuroscience, philosophy, systems].map((p) => ProfilePreset.parse(p));
