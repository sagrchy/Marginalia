import type { MessageAction, ModelRole } from "./enums";

export type ActionDef = {
  id: MessageAction;
  label: string;
  /** Single-key reader shortcut (Appendix A). */
  shortcut?: string;
  role: ModelRole;
  /** In lean mode, quick actions drop to the fast model. */
  leanRole?: ModelRole;
  output: "reply";
  /** Shown as a quick-action button in the tutor pane. */
  quick: boolean;
  /** Offered on a text selection. */
  onSelection?: boolean;
  /** Default message text when the user sends the action without typing. */
  defaultText: string;
};

/** Action registry: adding a quick action = one prompt file in prompts/actions/ + one entry here. */
export const ACTIONS: ActionDef[] = [
  { id: "ask", label: "Ask", shortcut: "a", role: "tutor", output: "reply", quick: false, onSelection: true, defaultText: "What does this mean?" },
  { id: "explain", label: "Explain", shortcut: "e", role: "tutor", leanRole: "fast", output: "reply", quick: true, onSelection: true, defaultText: "Explain this." },
  { id: "hint", label: "Hint", shortcut: "h", role: "tutor", leanRole: "fast", output: "reply", quick: true, onSelection: true, defaultText: "Give me a hint." },
  { id: "check", label: "Check me", shortcut: "c", role: "tutor", leanRole: "fast", output: "reply", quick: true, defaultText: "Check my understanding." },
  { id: "challenge", label: "Challenge", shortcut: "x", role: "tutor", leanRole: "fast", output: "reply", quick: true, defaultText: "Challenge this." },
  { id: "summarize", label: "Summarize", shortcut: "s", role: "fast", output: "reply", quick: true, defaultText: "Summarize this page." },
  { id: "deeper", label: "Go deeper", role: "deep", output: "reply", quick: false, defaultText: "Go deeper on this." },
  { id: "reveal", label: "Reveal", role: "tutor", output: "reply", quick: false, defaultText: "reveal" },
  { id: "discuss", label: "Discuss", role: "tutor", output: "reply", quick: false, defaultText: "Let's discuss this parked question." },
];

export const ACTION_BY_ID: Record<MessageAction, ActionDef> = Object.fromEntries(ACTIONS.map((a) => [a.id, a])) as Record<
  MessageAction,
  ActionDef
>;
