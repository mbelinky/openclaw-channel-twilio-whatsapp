import {
  buildCanonicalSentMessageHookContext,
  fireAndForgetHook,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from 'openclaw/plugin-sdk/hook-runtime';
import { getGlobalHookRunner } from 'openclaw/plugin-sdk/plugin-runtime';

const CHANNEL_ID = 'twilio-whatsapp';

export function emitTwilioWhatsAppMessageSentHook(params: {
  to: string;
  content: string;
  success: boolean;
  error?: string;
  accountId: string;
  messageId?: string;
  sessionKey?: string;
}): void {
  try {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner?.hasHooks?.('message_sent')) return;

    const canonical = buildCanonicalSentMessageHookContext({
      to: params.to,
      content: params.content,
      success: params.success,
      error: params.error,
      channelId: CHANNEL_ID,
      accountId: params.accountId,
      conversationId: params.to,
      messageId: params.messageId,
      sessionKey: params.sessionKey,
      isGroup: false,
    });
    fireAndForgetHook(
      Promise.resolve(
        hookRunner.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      ),
      'twilio-whatsapp: message_sent plugin hook failed',
    );
  } catch {
    // Hook failures must never affect WhatsApp message delivery.
  }
}
