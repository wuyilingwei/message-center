import type { ConversationType, MessageTrigger } from "./types.js";

export const BROADCAST_MENTION = /@\s*(?:全体成员|全体|所有人|all)(?=\s|$|[，,。.!！:：])/iu;

interface MentionElement {
  content?: string;
  atType?: number;
  atTargetAlias?: string;
}
export function classifyMessageTrigger(input: {
  conversationType: ConversationType;
  text: string;
  textElements: MentionElement[];
  mentionTerms: string[];
  requiredPrefix: string;
}): { trigger: MessageTrigger; mentioned: boolean } {
  if (input.conversationType === "direct") return { trigger: "direct", mentioned: false };
  const nativeMention = input.textElements.some((element) =>
    Number(element.atType ?? 0) > 0 && Boolean(element.atTargetAlias) &&
    !BROADCAST_MENTION.test(element.content ?? "")
  );
  const normalizedText = input.text.toLocaleLowerCase();
  const configuredMention = input.mentionTerms.some((term) =>
    !BROADCAST_MENTION.test(term) && normalizedText.includes(term.toLocaleLowerCase())
  );
  const mentioned = nativeMention || configuredMention;
  if (mentioned) return { trigger: "mention", mentioned: true };
  if (input.requiredPrefix && input.text.trimStart().startsWith(input.requiredPrefix)) {
    return { trigger: "explicit_request", mentioned: false };
  }
  return { trigger: "background", mentioned: false };
}
