// Fetches an article's lead (og:image) picture URL. Used by the auto-renderer when a card
// opts into using the source outlet's own image — the credit line names the outlet.
export async function fetchArticleImage(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
    return (
      parsed
        .querySelector('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]')
        ?.getAttribute('content') ?? null
    );
  } finally {
    window.clearTimeout(timer);
  }
}

// Fetches an article's opening paragraphs (via a CORS proxy) for editorial reference —
// used to enrich the Claude brief so verification starts from the actual reporting.
export async function fetchArticleExcerpt(url: string, maxChars = 1200): Promise<string> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    parsed.querySelectorAll('script, style, nav, header, footer, aside, form, figure').forEach((node) => node.remove());

    const paragraphs = Array.from(parsed.querySelectorAll('article p, main p, p'))
      .map((paragraph) => (paragraph.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter((text) => text.length > 60);

    let excerpt = '';
    for (const paragraph of [...new Set(paragraphs)]) {
      if (excerpt.length + paragraph.length > maxChars) {
        break;
      }
      excerpt += (excerpt ? '\n' : '') + paragraph;
    }

    return excerpt;
  } finally {
    window.clearTimeout(timer);
  }
}
