import type { IncomingMessage, ServerResponse } from 'http';

export const INBOUND_WEBHOOK_PATHS = ['/webhook/twilio-whatsapp', '/webhook/twilio'] as const;
export const STATUS_WEBHOOK_PATH = '/webhook/twilio-whatsapp/status';
export const MEDIA_WEBHOOK_PATH = '/webhook/twilio-whatsapp/media';
export const HEALTH_WEBHOOK_PATH = '/webhook/twilio-whatsapp/health';

type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface SharedTwilioRouteHandlers {
  inbound: HttpHandler;
  status: HttpHandler;
  media: HttpHandler;
  health: HttpHandler;
}

export interface TwilioRouteRegistration {
  path: string;
  auth: 'plugin';
  match?: 'prefix';
  replaceExisting: true;
  pluginId: 'twilio-whatsapp';
  handler: HttpHandler;
}

export type RegisterTwilioRoute = (registration: TwilioRouteRegistration) => () => void;

export function createSharedTwilioRouteLifecycle(registerRoute: RegisterTwilioRoute) {
  let leaseCount = 0;
  let unregisterRoutes: Array<() => void> = [];

  return {
    acquire(handlers: SharedTwilioRouteHandlers): () => void {
      if (leaseCount === 0) {
        const registrations: TwilioRouteRegistration[] = [
          ...INBOUND_WEBHOOK_PATHS.map((path) => ({
            path,
            auth: 'plugin' as const,
            replaceExisting: true as const,
            pluginId: 'twilio-whatsapp' as const,
            handler: handlers.inbound,
          })),
          {
            path: STATUS_WEBHOOK_PATH,
            auth: 'plugin',
            replaceExisting: true,
            pluginId: 'twilio-whatsapp',
            handler: handlers.status,
          },
          {
            path: MEDIA_WEBHOOK_PATH,
            auth: 'plugin',
            match: 'prefix',
            replaceExisting: true,
            pluginId: 'twilio-whatsapp',
            handler: handlers.media,
          },
          {
            path: HEALTH_WEBHOOK_PATH,
            auth: 'plugin',
            replaceExisting: true,
            pluginId: 'twilio-whatsapp',
            handler: handlers.health,
          },
        ];
        unregisterRoutes = [];
        try {
          for (const registration of registrations) {
            unregisterRoutes.push(registerRoute(registration));
          }
        } catch (error) {
          const registered = unregisterRoutes;
          unregisterRoutes = [];
          for (const unregister of registered) unregister();
          throw error;
        }
      }
      leaseCount += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        leaseCount -= 1;
        if (leaseCount !== 0) return;
        const current = unregisterRoutes;
        unregisterRoutes = [];
        for (const unregister of current) unregister();
      };
    },
    activeLeases(): number {
      return leaseCount;
    },
  };
}
