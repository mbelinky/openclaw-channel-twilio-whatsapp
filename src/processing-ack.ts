export interface ProcessingAckHandle {
  complete: () => void;
}

export function scheduleProcessingAck(options: {
  text?: string;
  delayMs?: number;
  send: (text: string) => Promise<unknown>;
  onError?: (error: unknown) => void;
}): ProcessingAckHandle | undefined {
  const text = options.text?.trim();
  if (!text) return undefined;

  let completed = false;
  const timer = setTimeout(() => {
    if (completed) return;
    options.send(text).catch((error) => {
      options.onError?.(error);
    });
  }, Math.max(0, options.delayMs ?? 12000));

  return {
    complete: () => {
      completed = true;
      clearTimeout(timer);
    },
  };
}
