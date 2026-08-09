const DEFAULT_TWILIO_MAX_MESSAGE_LEN = 1600;

function resolveChunkLimit(maxLen: number): number {
  if (!Number.isFinite(maxLen) || maxLen < 1) return DEFAULT_TWILIO_MAX_MESSAGE_LEN;
  return Math.floor(maxLen);
}

export function normalizeWhatsAppText(text: string): string {
  if (!text) return '';
  let normalized = text.normalize('NFKC');
  const replacements: Record<string, string> = {
    '\u201c': '"',
    '\u201d': '"',
    '\u2018': "'",
    '\u2019': "'",
    '\u2014': '--',
    '\u2013': '-',
    '\u2026': '...',
  };
  for (const [source, target] of Object.entries(replacements)) {
    normalized = normalized.split(source).join(target);
  }
  normalized = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join('\n');
  normalized = normalized.replace(/\n{3,}/g, '\n\n');
  normalized = normalized.replace(/:\s*-\s*/g, ': ');
  normalized = normalized.replace(/^\s*-\s*/gm, '');
  normalized = normalized.replace(/\*\*(.*?)\*\*/g, '*$1*');
  normalized = normalized.replace(/__(.*?)__/g, '*$1*');
  normalized = normalized.replace(/~~(.*?)~~/g, '~$1~');
  normalized = normalized.replace(/```(?:[A-Za-z0-9_-]+)?\n?([\s\S]*?)```/g, '$1');
  normalized = normalized.replace(/\n{3,}/g, '\n\n');
  normalized = normalized.replace(/`(.*?)`/g, '$1');
  return normalized.trim();
}

export function splitWhatsAppText(text: string, maxLen = DEFAULT_TWILIO_MAX_MESSAGE_LEN): string[] {
  maxLen = resolveChunkLimit(maxLen);
  const normalized = text || '';
  if (normalized.length <= maxLen) return [normalized];

  const chunks: string[] = [];
  let current = '';
  const blocks = normalized.split('\n\n');

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxLen) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (block.length <= maxLen) {
      current = block;
      continue;
    }
    for (const line of block.split(/\r?\n/)) {
      const lineCandidate = current ? `${current}\n${line}` : line;
      if (lineCandidate.length <= maxLen) {
        current = lineCandidate;
        continue;
      }
      if (current) chunks.push(current);
      current = line.slice(0, maxLen);
      let remainder = line.slice(maxLen);
      while (remainder) {
        chunks.push(current);
        current = remainder.slice(0, maxLen);
        remainder = remainder.slice(maxLen);
      }
    }
  }

  if (current) chunks.push(current);
  return chunks.length ? chunks : [''];
}
