import {
  emitDiagnosticEvent,
  type DiagnosticEventPayload,
} from 'openclaw/plugin-sdk/diagnostic-runtime';

type DiagnosticEventInput = DiagnosticEventPayload extends infer Event
  ? Event extends DiagnosticEventPayload
    ? Omit<Event, 'seq' | 'ts'>
    : never
  : never;

export type TimingLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type TimingValue = string | number | boolean | undefined | null;

function formatValue(value: TimingValue): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value).replace(/\s+/g, '_');
}

export function logTiming(
  log: TimingLogger | undefined,
  event: string,
  fields: Record<string, TimingValue> = {},
): void {
  const parts = Object.entries(fields)
    .map(([key, value]) => {
      const formatted = formatValue(value);
      return formatted ? `${key}=${formatted}` : undefined;
    })
    .filter((part): part is string => Boolean(part));
  log?.info?.(`[twilio-whatsapp] timing event=${event}${parts.length ? ` ${parts.join(' ')}` : ''}`);
}

export function emitTimingEvent(event: DiagnosticEventInput): void {
  try {
    emitDiagnosticEvent(event);
  } catch {
    // Diagnostics must never affect channel delivery.
  }
}
