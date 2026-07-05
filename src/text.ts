export function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

export function stripHtml(value: string) {
  if (!value) {
    return '';
  }

  const parser = new DOMParser();
  const parsed = parser.parseFromString(value, 'text/html');
  return normalizeWhitespace(parsed.body.textContent ?? '');
}

export function decodeEntities(value: string) {
  // Some feeds double-encode ("&amp;#39;"), so decode until the text stops changing.
  let current = normalizeWhitespace(value);
  for (let pass = 0; pass < 3 && /[&<]/.test(current); pass += 1) {
    const next = stripHtml(current);
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
}

export function clampText(value: string, limit: number) {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

export function formatDateTime(value?: string) {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return parsed.toLocaleString('en-GH', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function downloadText(fileName: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
