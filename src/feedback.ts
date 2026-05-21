import https from 'https';

export function buildTwilioTypingIndicatorBody(messageSid: string): string {
  return new URLSearchParams({
    messageId: messageSid,
    channel: 'whatsapp',
  }).toString();
}

export function sendTwilioTypingIndicator(params: {
  accountSid: string;
  authToken: string;
  messageSid: string;
  timeoutMs?: number;
}): Promise<boolean> {
  if (!params.messageSid) return Promise.resolve(false);

  const body = buildTwilioTypingIndicatorBody(params.messageSid);

  return new Promise((resolve) => {
    const request = https.request(
      'https://messaging.twilio.com/v2/Indicators/Typing.json',
      {
        method: 'POST',
        auth: `${params.accountSid}:${params.authToken}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
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
