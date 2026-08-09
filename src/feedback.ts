import https from 'https';

export const TWILIO_TYPING_INDICATOR_URL = 'https://messaging.twilio.com/v3/Indicators/Typing.json';

export function buildTwilioTypingIndicatorBody(messageSid: string): string {
  return JSON.stringify({
    messageId: messageSid,
    channel: 'whatsapp',
  });
}

export function sendTwilioTypingIndicator(params: {
  accountSid: string;
  authToken: string;
  messageSid: string;
  timeoutMs?: number;
  request?: typeof https.request;
}): Promise<boolean> {
  if (!params.messageSid) return Promise.resolve(false);

  const body = buildTwilioTypingIndicatorBody(params.messageSid);

  return new Promise((resolve) => {
    const request = (params.request || https.request)(
      TWILIO_TYPING_INDICATOR_URL,
      {
        method: 'POST',
        auth: `${params.accountSid}:${params.authToken}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(Boolean(res.statusCode && res.statusCode < 400)));
      },
    );
    request.setTimeout(params.timeoutMs ?? 5000, () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
    request.end(body);
  });
}
