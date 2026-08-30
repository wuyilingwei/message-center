import type { AppConfig } from "./config.js";
import type { GroupPolicy, IncomingBridgeMessage, MessageScope } from "./types.js";

function findPolicy(config: AppConfig, conversationId: string): GroupPolicy | undefined {
  return config.groups.find((policy) => policy.conversationId === conversationId);
}

export function evaluateMessagePolicy(config: AppConfig, message: IncomingBridgeMessage): MessageScope {
  const policy = findPolicy(config, message.conversation.id);
  if (!policy || !policy.enabled) {
    return {
      trustTier: "untrusted",
      projectIds: [],
      allowedActions: [],
      replyPolicy: config.defaultUntrustedReplyPolicy,
      reason: policy ? "conversation_disabled" : "conversation_not_enrolled"
    };
  }

  if (policy.requireVerifiedIdentity &&
      (message.conversation.assurance !== "verified" || message.sender.assurance !== "verified")) {
    return {
      trustTier: "rejected",
      projectIds: [],
      allowedActions: [],
      replyPolicy: "none",
      reason: "identity_not_verified"
    };
  }

  if (policy.allowedSenderIds.length > 0 && !policy.allowedSenderIds.includes(message.sender.id)) {
    return {
      trustTier: "rejected",
      projectIds: [],
      allowedActions: [],
      replyPolicy: "none",
      reason: "sender_not_authorized"
    };
  }

  if (policy.requiredPrefix && !message.text.trimStart().startsWith(policy.requiredPrefix)) {
    return {
      trustTier: "untrusted",
      projectIds: [],
      allowedActions: [],
      replyPolicy: config.defaultUntrustedReplyPolicy,
      reason: "trigger_prefix_missing"
    };
  }

  return {
    trustTier: "trusted",
    projectIds: [...policy.projectIds],
    allowedActions: [...policy.allowedActions],
    replyPolicy: policy.replyPolicy,
    reason: "enrolled_conversation_and_sender"
  };
}
