import {
  createPluginRuntimeStore,
  type PluginRuntime,
} from 'openclaw/plugin-sdk/runtime-store';

export const { setRuntime: setTwilioWhatsAppRuntime, getRuntime: getTwilioWhatsAppRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: 'twilio-whatsapp',
    errorMessage: 'Twilio WhatsApp runtime not initialized',
  });
