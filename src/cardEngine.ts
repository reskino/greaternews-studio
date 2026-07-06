export type CardFormat = 'portrait' | 'square' | 'story';
export type CardTemplate = 'headline' | 'quote' | 'update' | 'stat' | 'recap' | 'post';
export type ChipLabel = 'UPDATE' | 'DEVELOPING' | 'BREAKING';

export type CardOptions = {
  template: CardTemplate;
  format: CardFormat;
  photo: HTMLImageElement | null;
  logo: HTMLImageElement | null;
  headline: string;
  subline: string;
  highlight: string;
  attribution: string;
  chip: ChipLabel;
  statValue: string;
  postHandle: string;
  postMeta: string;
  footer: string;
  handle: string;
  accent: string;
  dim: number;
};

type CanvasCtx = CanvasRenderingContext2D & { letterSpacing?: string };

type HeadlineWord = {
  text: string;
  highlighted: boolean;
};

export const formatSizes: Record<CardFormat, { width: number; height: number; label: string; suffix: string }> = {
  portrait: { width: 1080, height: 1350, label: 'Portrait 4:5 — Facebook / Instagram feed', suffix: '4x5' },
  square: { width: 1080, height: 1080, label: 'Square 1:1 — X / WhatsApp', suffix: '1x1' },
  story: { width: 1080, height: 1920, label: 'Story 9:16 — Status / Reels cover', suffix: '9x16' },
};

export const templateMeta: Record<CardTemplate, { label: string; note: string }> = {
  headline: { label: 'Headline', note: 'The main story card — photo plus bold headline.' },
  quote: { label: 'Quote', note: 'A short attributed quote, spoken words front and center.' },
  update: { label: 'Update', note: 'Follow-up card with an UPDATE / DEVELOPING / BREAKING banner.' },
  stat: { label: 'Stat', note: 'One big number with what it means.' },
  recap: { label: 'Recap', note: 'Week in review — up to five headlines, one per line.' },
  post: { label: 'Social post', note: 'A statement rendered as a social-style post — our own graphic, no screenshot needed.' },
};

export const chipColors: Record<ChipLabel, string> = {
  UPDATE: '#4fd1a3',
  DEVELOPING: '#f3c457',
  BREAKING: '#e5484d',
};

const FONT_STACK = "'Poppins', 'IBM Plex Sans', sans-serif";
const BG = '#060606';

function normalizeWord(word: string) {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
}

function splitHeadlineWords(headline: string, highlight: string): HeadlineWord[] {
  const words = headline.split(/\s+/).filter(Boolean);
  const highlightWords = highlight.split(/\s+/).map(normalizeWord).filter(Boolean);

  if (highlightWords.length === 0) {
    return words.map((text) => ({ text, highlighted: false }));
  }

  const normalized = words.map(normalizeWord);
  let start = -1;

  for (let index = 0; index + highlightWords.length <= normalized.length; index += 1) {
    if (highlightWords.every((word, offset) => normalized[index + offset] === word)) {
      start = index;
      break;
    }
  }

  return words.map((text, index) => ({
    text,
    highlighted: start >= 0 && index >= start && index < start + highlightWords.length,
  }));
}

function layoutLines(ctx: CanvasRenderingContext2D, words: HeadlineWord[], maxWidth: number) {
  const spaceWidth = ctx.measureText(' ').width;
  const lines: HeadlineWord[][] = [];
  let line: HeadlineWord[] = [];
  let lineWidth = 0;

  for (const word of words) {
    const wordWidth = ctx.measureText(word.text).width;
    const extra = line.length > 0 ? spaceWidth : 0;

    if (line.length > 0 && lineWidth + extra + wordWidth > maxWidth) {
      lines.push(line);
      line = [word];
      lineWidth = wordWidth;
    } else {
      line.push(word);
      lineWidth += extra + wordWidth;
    }
  }

  if (line.length > 0) {
    lines.push(line);
  }

  return lines;
}

function drawWrappedBlock(
  ctx: CanvasRenderingContext2D,
  words: HeadlineWord[],
  options: {
    width: number;
    top: number;
    maxWidth: number;
    baseFontSize: number;
    minFontSize: number;
    maxLines: number;
    maxBottom: number;
    weight: number;
    accent: string;
    color: string;
    lineHeightFactor?: number;
  },
) {
  const lineHeightFactor = options.lineHeightFactor ?? 1.2;
  let fontSize = options.baseFontSize;
  let lines: HeadlineWord[][] = [];

  while (fontSize >= options.minFontSize) {
    ctx.font = `${options.weight} ${fontSize}px ${FONT_STACK}`;
    lines = layoutLines(ctx, words, options.maxWidth);
    const blockHeight = lines.length * fontSize * lineHeightFactor;
    if (lines.length <= options.maxLines && options.top + blockHeight <= options.maxBottom) {
      break;
    }
    fontSize -= 4;
  }

  ctx.font = `${options.weight} ${fontSize}px ${FONT_STACK}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const lineHeight = fontSize * lineHeightFactor;
  const spaceWidth = ctx.measureText(' ').width;

  lines.forEach((line, lineIndex) => {
    const lineWidth = line.reduce(
      (total, word, wordIndex) => total + ctx.measureText(word.text).width + (wordIndex > 0 ? spaceWidth : 0),
      0,
    );
    let x = (options.width - lineWidth) / 2;
    const y = options.top + lineIndex * lineHeight;

    for (const word of line) {
      ctx.fillStyle = word.highlighted ? options.accent : options.color;
      ctx.fillText(word.text, x, y);
      x += ctx.measureText(word.text).width + spaceWidth;
    }
  });

  return options.top + lines.length * lineHeight;
}

type BlockLayout = {
  lines: HeadlineWord[][];
  fontSize: number;
  lineHeight: number;
  height: number;
};

function fitBlock(
  ctx: CanvasRenderingContext2D,
  words: HeadlineWord[],
  options: { maxWidth: number; baseFontSize: number; minFontSize: number; maxLines: number; maxHeight: number; weight: number; lineHeightFactor?: number },
): BlockLayout {
  const factor = options.lineHeightFactor ?? 1.2;
  let fontSize = options.baseFontSize;
  let lines: HeadlineWord[][] = [];

  while (fontSize >= options.minFontSize) {
    ctx.font = `${options.weight} ${fontSize}px ${FONT_STACK}`;
    lines = layoutLines(ctx, words, options.maxWidth);
    if (lines.length <= options.maxLines && lines.length * fontSize * factor <= options.maxHeight) {
      break;
    }
    fontSize -= 4;
  }

  return { lines, fontSize, lineHeight: fontSize * factor, height: lines.length * fontSize * factor };
}

function paintBlock(
  ctx: CanvasRenderingContext2D,
  layout: BlockLayout,
  options: { width: number; top: number; weight: number; accent: string; color: string },
) {
  ctx.font = `${options.weight} ${layout.fontSize}px ${FONT_STACK}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const spaceWidth = ctx.measureText(' ').width;

  layout.lines.forEach((line, lineIndex) => {
    const lineWidth = line.reduce(
      (total, word, wordIndex) => total + ctx.measureText(word.text).width + (wordIndex > 0 ? spaceWidth : 0),
      0,
    );
    let x = (options.width - lineWidth) / 2;
    const y = options.top + lineIndex * layout.lineHeight;

    for (const word of line) {
      ctx.fillStyle = word.highlighted ? options.accent : options.color;
      ctx.fillText(word.text, x, y);
      x += ctx.measureText(word.text).width + spaceWidth;
    }
  });

  return options.top + layout.height;
}

// Headline plus optional subline, vertically centered in the available zone.
// Short headlines get a capped size boost so the card never looks half-empty.
function fitHeadlineGroup(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  options: CardOptions,
  available: number,
  baseFontSize: number,
) {
  const words = splitHeadlineWords(options.headline || 'Type the headline in the Card Studio', options.highlight);
  const maxWidth = width * 0.88;
  const storyFormat = options.format === 'story';

  const boosted = fitBlock(ctx, words, {
    maxWidth,
    baseFontSize: Math.round(baseFontSize * 1.24),
    minFontSize: baseFontSize,
    maxLines: 2,
    maxHeight: available,
    weight: 800,
  });

  const headline =
    boosted.fontSize > baseFontSize && boosted.lines.length <= 2
      ? boosted
      : fitBlock(ctx, words, {
          maxWidth,
          baseFontSize,
          minFontSize: 34,
          maxLines: storyFormat ? 6 : 4,
          maxHeight: available,
          weight: 800,
        });

  const gap = Math.round(height * 0.02);
  let subline: BlockLayout | null = null;
  if (options.subline.trim()) {
    subline = fitBlock(ctx, splitHeadlineWords(options.subline, ''), {
      maxWidth: width * 0.84,
      baseFontSize: Math.round(width * 0.026),
      minFontSize: Math.round(width * 0.02),
      maxLines: 3,
      maxHeight: Math.max(40, available - headline.height - gap),
      weight: 500,
      lineHeightFactor: 1.45,
    });
  }

  const groupHeight = headline.height + (subline ? gap + subline.height : 0);
  return { headline, subline, gap, groupHeight };
}

function paintHeadlineGroup(
  ctx: CanvasRenderingContext2D,
  width: number,
  top: number,
  group: { headline: BlockLayout; subline: BlockLayout | null; gap: number },
  accent: string,
) {
  const headlineBottom = paintBlock(ctx, group.headline, { width, top, weight: 800, accent, color: '#ffffff' });
  if (group.subline) {
    paintBlock(ctx, group.subline, { width, top: headlineBottom + group.gap, weight: 500, accent, color: 'rgba(255, 255, 255, 0.72)' });
  }
}

function tracePill(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.arcTo(x + width, y, x + width, y + radius, radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
  ctx.lineTo(x + radius, y + height);
  ctx.arcTo(x, y + height, x, y + height - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function drawPhotoCover(ctx: CanvasRenderingContext2D, photo: HTMLImageElement, width: number, height: number) {
  const scale = Math.max(width / photo.width, height / photo.height);
  const drawnWidth = photo.width * scale;
  const drawnHeight = photo.height * scale;
  const x = (width - drawnWidth) / 2;
  // Anchor toward the top of the photo, where faces usually are.
  const y = (height - drawnHeight) * 0.3;

  ctx.drawImage(photo, x, y, drawnWidth, drawnHeight);
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const glowOne = ctx.createRadialGradient(width * 0.3, height * 0.3, 0, width * 0.3, height * 0.3, width * 0.5);
  glowOne.addColorStop(0, 'rgba(243, 196, 87, 0.28)');
  glowOne.addColorStop(1, 'rgba(243, 196, 87, 0)');
  ctx.fillStyle = glowOne;
  ctx.fillRect(0, 0, width, height);

  const glowTwo = ctx.createRadialGradient(width * 0.75, height * 0.5, 0, width * 0.75, height * 0.5, width * 0.45);
  glowTwo.addColorStop(0, 'rgba(79, 209, 163, 0.22)');
  glowTwo.addColorStop(1, 'rgba(79, 209, 163, 0)');
  ctx.fillStyle = glowTwo;
  ctx.fillRect(0, 0, width, height);
}

function drawBase(ctx: CanvasCtx, width: number, height: number, photoHeight: number, options: CardOptions) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, photoHeight);
  ctx.clip();
  if (options.photo) {
    drawPhotoCover(ctx, options.photo, width, photoHeight);
  } else {
    drawPlaceholder(ctx, width, photoHeight);
  }
  if (options.dim > 0) {
    ctx.fillStyle = `rgba(0, 0, 0, ${options.dim})`;
    ctx.fillRect(0, 0, width, photoHeight);
  }
  ctx.restore();

  const fade = ctx.createLinearGradient(0, photoHeight * 0.5, 0, photoHeight);
  fade.addColorStop(0, 'rgba(6, 6, 6, 0)');
  fade.addColorStop(1, 'rgba(6, 6, 6, 1)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, photoHeight * 0.5, width, photoHeight * 0.5 + 2);
}

function drawLogoBadge(ctx: CanvasCtx, width: number, options: CardOptions) {
  const badgeSize = Math.round(width * 0.085);
  const badgeMargin = Math.round(width * 0.055);
  const badgeX = width - badgeMargin - badgeSize;

  tracePill(ctx, badgeX, badgeMargin, badgeSize, badgeSize, Math.round(badgeSize * 0.22));
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = Math.max(3, Math.round(width * 0.004));
  ctx.stroke();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fill();

  if (options.logo) {
    const pad = Math.round(badgeSize * 0.16);
    const inner = badgeSize - pad * 2;
    const scale = Math.min(inner / options.logo.width, inner / options.logo.height);
    const drawnWidth = options.logo.width * scale;
    const drawnHeight = options.logo.height * scale;
    ctx.drawImage(
      options.logo,
      badgeX + (badgeSize - drawnWidth) / 2,
      badgeMargin + (badgeSize - drawnHeight) / 2,
      drawnWidth,
      drawnHeight,
    );
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${Math.round(badgeSize * 0.42)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('GN', badgeX + badgeSize / 2, badgeMargin + badgeSize / 2 + badgeSize * 0.03);
  }
}

function drawBrandStrip(ctx: CanvasCtx, width: number, y: number) {
  const brandFontSize = Math.round(width * 0.028);
  ctx.font = `700 ${brandFontSize}px ${FONT_STACK}`;
  ctx.letterSpacing = `${Math.round(brandFontSize * 0.28)}px`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.66)';
  const brandText = 'GREATERNEWS';
  ctx.fillText(brandText, width / 2, y);
  const brandWidth = ctx.measureText(brandText).width;
  ctx.letterSpacing = '0px';

  const ruleLength = Math.round(width * 0.055);
  const ruleY = y + brandFontSize * 0.55;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(width / 2 - brandWidth / 2 - 28 - ruleLength, ruleY);
  ctx.lineTo(width / 2 - brandWidth / 2 - 28, ruleY);
  ctx.moveTo(width / 2 + brandWidth / 2 + 28, ruleY);
  ctx.lineTo(width / 2 + brandWidth / 2 + 28 + ruleLength, ruleY);
  ctx.stroke();

  return y + brandFontSize;
}

function drawBottomStrips(ctx: CanvasCtx, width: number, height: number, options: CardOptions) {
  const handleText = options.handle.trim();
  const footerText = options.footer.trim();

  if (handleText) {
    ctx.font = `600 ${Math.round(width * 0.021)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.fillText(handleText, width / 2, height - Math.round(height * (footerText ? 0.052 : 0.028)));
  }

  if (footerText) {
    ctx.font = `500 ${Math.round(width * 0.017)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fillText(footerText, width / 2, height - Math.round(height * 0.024));
  }
}

function bottomReserve(height: number, options: CardOptions) {
  const hasFooter = options.footer.trim().length > 0;
  const hasHandle = options.handle.trim().length > 0;
  return Math.round(height * (0.03 + (hasFooter ? 0.03 : 0) + (hasHandle ? 0.035 : 0)));
}

function drawChip(ctx: CanvasCtx, width: number, y: number, label: ChipLabel) {
  const fontSize = Math.round(width * 0.024);
  ctx.font = `800 ${fontSize}px ${FONT_STACK}`;
  ctx.letterSpacing = `${Math.round(fontSize * 0.14)}px`;
  const textWidth = ctx.measureText(label).width;
  ctx.letterSpacing = '0px';
  const padX = Math.round(width * 0.024);
  const chipWidth = textWidth + padX * 2;
  const chipHeight = Math.round(fontSize * 2.1);
  const x = (width - chipWidth) / 2;

  tracePill(ctx, x, y, chipWidth, chipHeight, chipHeight / 2);
  ctx.fillStyle = chipColors[label];
  ctx.fill();
  ctx.font = `800 ${fontSize}px ${FONT_STACK}`;
  ctx.letterSpacing = `${Math.round(fontSize * 0.14)}px`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#081110';
  ctx.fillText(label, width / 2, y + chipHeight / 2 + 1);
  ctx.letterSpacing = '0px';

  return y + chipHeight;
}

function drawHeadlineTemplate(ctx: CanvasCtx, width: number, height: number, options: CardOptions) {
  const photoHeight = Math.round(height * (options.format === 'square' ? 0.56 : 0.64));
  drawBase(ctx, width, height, photoHeight, options);
  drawLogoBadge(ctx, width, options);
  const brandBottom = drawBrandStrip(ctx, width, photoHeight + Math.round(height * 0.006));

  const groupTop = brandBottom + Math.round(height * 0.024);
  const available = height - bottomReserve(height, options) - groupTop;
  const group = fitHeadlineGroup(ctx, width, height, options, available, Math.round(width * (options.format === 'square' ? 0.056 : 0.062)));

  // Slight upward bias keeps the optical balance when centering short text.
  const offset = Math.max(0, ((available - group.groupHeight) / 2) * 0.8);
  paintHeadlineGroup(ctx, width, groupTop + offset, group, options.accent);

  drawBottomStrips(ctx, width, height, options);
}

function drawUpdateTemplate(ctx: CanvasCtx, width: number, height: number, options: CardOptions) {
  const photoHeight = Math.round(height * (options.format === 'square' ? 0.52 : 0.6));
  drawBase(ctx, width, height, photoHeight, options);
  drawLogoBadge(ctx, width, options);
  const brandBottom = drawBrandStrip(ctx, width, photoHeight + Math.round(height * 0.006));

  const groupTop = brandBottom + Math.round(height * 0.018);
  const chipFontSize = Math.round(width * 0.024);
  const chipHeight = Math.round(chipFontSize * 2.1);
  const chipGap = Math.round(height * 0.02);
  const available = height - bottomReserve(height, options) - groupTop - chipHeight - chipGap;
  const group = fitHeadlineGroup(ctx, width, height, options, available, Math.round(width * 0.054));

  const offset = Math.max(0, ((available - group.groupHeight) / 2) * 0.8);
  const chipBottom = drawChip(ctx, width, groupTop + offset, options.chip);
  paintHeadlineGroup(ctx, width, chipBottom + chipGap, group, options.accent);

  drawBottomStrips(ctx, width, height, options);
}

function drawQuoteTemplate(ctx: CanvasCtx, width: number, height: number, options: CardOptions) {
  const photoHeight = Math.round(height * (options.format === 'square' ? 0.42 : 0.5));
  drawBase(ctx, width, height, photoHeight, options);
  drawLogoBadge(ctx, width, options);
  const brandBottom = drawBrandStrip(ctx, width, photoHeight + Math.round(height * 0.006));

  const glyphSize = Math.round(width * 0.13);
  ctx.font = `800 ${glyphSize}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = options.accent;
  const glyphTop = brandBottom + Math.round(height * 0.012);
  ctx.fillText('“', width / 2, glyphTop + glyphSize * 0.78);

  const words = splitHeadlineWords(options.headline || 'Paste the exact quote here', '');
  const quoteBottom = drawWrappedBlock(ctx, words, {
    width,
    top: glyphTop + Math.round(glyphSize * 0.75),
    maxWidth: width * 0.84,
    baseFontSize: Math.round(width * 0.048),
    minFontSize: 30,
    maxLines: options.format === 'story' ? 8 : 6,
    maxBottom: height - bottomReserve(height, options) - Math.round(height * 0.05),
    weight: 600,
    accent: options.accent,
    color: '#ffffff',
    lineHeightFactor: 1.32,
  });

  const attribution = options.attribution.trim();
  if (attribution) {
    ctx.font = `700 ${Math.round(width * 0.026)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = options.accent;
    ctx.fillText(`— ${attribution}`, width / 2, quoteBottom + Math.round(height * 0.02));
  }

  drawBottomStrips(ctx, width, height, options);
}

function drawStatTemplate(ctx: CanvasCtx, width: number, height: number, options: CardOptions) {
  const photoHeight = Math.round(height * (options.format === 'square' ? 0.36 : 0.44));
  drawBase(ctx, width, height, photoHeight, options);
  drawLogoBadge(ctx, width, options);
  const brandBottom = drawBrandStrip(ctx, width, photoHeight + Math.round(height * 0.006));

  const statValue = options.statValue.trim() || '0';
  let statFontSize = Math.round(width * 0.17);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  while (statFontSize > 60) {
    ctx.font = `800 ${statFontSize}px ${FONT_STACK}`;
    if (ctx.measureText(statValue).width <= width * 0.86) {
      break;
    }
    statFontSize -= 8;
  }
  const statTop = brandBottom + Math.round(height * 0.02);
  ctx.fillStyle = options.accent;
  ctx.fillText(statValue, width / 2, statTop);

  const words = splitHeadlineWords(options.headline || 'What this number means', options.highlight);
  drawWrappedBlock(ctx, words, {
    width,
    top: statTop + Math.round(statFontSize * 1.16),
    maxWidth: width * 0.84,
    baseFontSize: Math.round(width * 0.04),
    minFontSize: 26,
    maxLines: options.format === 'story' ? 6 : 4,
    maxBottom: height - bottomReserve(height, options),
    weight: 600,
    accent: options.accent,
    color: '#ffffff',
    lineHeightFactor: 1.3,
  });

  drawBottomStrips(ctx, width, height, options);
}

function drawRecapTemplate(ctx: CanvasCtx, width: number, height: number, options: CardOptions) {
  const photoHeight = Math.round(height * (options.format === 'square' ? 0.26 : 0.3));
  drawBase(ctx, width, height, photoHeight, options);
  drawLogoBadge(ctx, width, options);
  const brandBottom = drawBrandStrip(ctx, width, photoHeight + Math.round(height * 0.006));

  ctx.font = `800 ${Math.round(width * 0.05)}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = options.accent;
  const titleTop = brandBottom + Math.round(height * 0.016);
  ctx.fillText('THE WEEK IN REVIEW', width / 2, titleTop);
  let cursor = titleTop + Math.round(width * 0.05 * 1.2);

  const subtitle = options.attribution.trim();
  if (subtitle) {
    ctx.font = `600 ${Math.round(width * 0.022)}px ${FONT_STACK}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.fillText(subtitle, width / 2, cursor);
    cursor += Math.round(width * 0.022 * 1.6);
  }

  const items = options.headline
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);

  const maxBottom = height - bottomReserve(height, options);
  const listTop = cursor + Math.round(height * 0.014);
  const leftMargin = Math.round(width * 0.1);
  const textLeft = leftMargin + Math.round(width * 0.055);
  const maxTextWidth = width - textLeft - Math.round(width * 0.08);

  let itemFontSize = Math.round(width * 0.03);
  let layout: Array<{ number: string; lines: HeadlineWord[][] }> = [];
  let totalHeight = 0;

  while (itemFontSize >= 20) {
    ctx.font = `600 ${itemFontSize}px ${FONT_STACK}`;
    layout = items.map((item, index) => ({
      number: String(index + 1),
      lines: layoutLines(ctx, splitHeadlineWords(item, ''), maxTextWidth),
    }));
    const gap = itemFontSize * 1.1;
    totalHeight = layout.reduce((sum, entry) => sum + entry.lines.length * itemFontSize * 1.3 + gap, 0);
    if (listTop + totalHeight <= maxBottom) {
      break;
    }
    itemFontSize -= 2;
  }

  let y = listTop;
  const lineHeight = itemFontSize * 1.3;
  const gap = itemFontSize * 1.1;

  layout.forEach((entry, entryIndex) => {
    ctx.font = `800 ${itemFontSize}px ${FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = options.accent;
    ctx.fillText(entry.number, leftMargin, y);

    ctx.font = `600 ${itemFontSize}px ${FONT_STACK}`;
    const spaceWidth = ctx.measureText(' ').width;
    entry.lines.forEach((line, lineIndex) => {
      let x = textLeft;
      ctx.fillStyle = '#ffffff';
      for (const word of line) {
        ctx.fillText(word.text, x, y + lineIndex * lineHeight);
        x += ctx.measureText(word.text).width + spaceWidth;
      }
    });

    y += entry.lines.length * lineHeight + gap;

    if (entryIndex < layout.length - 1) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(leftMargin, y - gap / 2);
      ctx.lineTo(width - Math.round(width * 0.08), y - gap / 2);
      ctx.stroke();
    }
  });

  drawBottomStrips(ctx, width, height, options);
}

function drawPostTemplate(ctx: CanvasCtx, width: number, height: number, options: CardOptions) {
  const photoHeight = Math.round(height * (options.format === 'square' ? 0.24 : 0.28));
  drawBase(ctx, width, height, photoHeight, options);
  drawLogoBadge(ctx, width, options);
  const brandBottom = drawBrandStrip(ctx, width, photoHeight + Math.round(height * 0.006));

  const name = options.attribution.trim() || 'Name of the speaker';
  const postHandle = options.postHandle.trim();
  const postMeta = options.postMeta.trim();
  const text = options.headline.trim() || 'Paste their exact words here';

  const boxX = Math.round(width * 0.08);
  const boxWidth = width - boxX * 2;
  const pad = Math.round(width * 0.05);
  const avatarSize = Math.round(width * 0.085);
  const boxTop = brandBottom + Math.round(height * 0.028);
  const maxBoxBottom = height - bottomReserve(height, options) - Math.round(height * 0.02);
  const textMaxWidth = boxWidth - pad * 2;

  // Fit the post text first so the box height can wrap around it.
  const words = splitHeadlineWords(text, '');
  let fontSize = Math.round(width * 0.042);
  let lines: HeadlineWord[][] = [];
  const nameFontSize = Math.round(width * 0.03);
  const handleFontSize = Math.round(width * 0.023);
  const metaFontSize = Math.round(width * 0.021);
  const headerHeight = Math.max(avatarSize, nameFontSize + handleFontSize + 10);

  while (fontSize >= 26) {
    ctx.font = `600 ${fontSize}px ${FONT_STACK}`;
    lines = layoutLines(ctx, words, textMaxWidth);
    const textHeight = lines.length * fontSize * 1.34;
    const boxHeight = pad + headerHeight + Math.round(height * 0.022) + textHeight + (postMeta ? metaFontSize * 2.6 : pad * 0.6) + pad * 0.8;
    if (boxTop + boxHeight <= maxBoxBottom) {
      break;
    }
    fontSize -= 3;
  }

  ctx.font = `600 ${fontSize}px ${FONT_STACK}`;
  const lineHeight = fontSize * 1.34;
  const textHeight = lines.length * lineHeight;
  const boxHeight = pad + headerHeight + Math.round(height * 0.022) + textHeight + (postMeta ? metaFontSize * 2.6 : pad * 0.6) + pad * 0.8;

  tracePill(ctx, boxX, boxTop, boxWidth, boxHeight, Math.round(width * 0.03));
  ctx.fillStyle = 'rgba(255, 255, 255, 0.055)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Avatar circle with initials.
  const avatarX = boxX + pad + avatarSize / 2;
  const avatarY = boxTop + pad + avatarSize / 2;
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, avatarSize / 2, 0, Math.PI * 2);
  ctx.fillStyle = options.accent;
  ctx.fill();
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
  ctx.fillStyle = '#081110';
  ctx.font = `800 ${Math.round(avatarSize * 0.42)}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials || 'GN', avatarX, avatarY + 1);

  // Name and handle.
  const headerTextX = boxX + pad + avatarSize + Math.round(width * 0.024);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = `700 ${nameFontSize}px ${FONT_STACK}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(name, headerTextX, boxTop + pad + (avatarSize - headerHeight) / 2 + 2, boxWidth - (headerTextX - boxX) - pad);
  if (postHandle) {
    ctx.font = `500 ${handleFontSize}px ${FONT_STACK}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillText(postHandle, headerTextX, boxTop + pad + (avatarSize - headerHeight) / 2 + nameFontSize + 8);
  }

  // Post text, left aligned.
  const textTop = boxTop + pad + headerHeight + Math.round(height * 0.022);
  ctx.font = `600 ${fontSize}px ${FONT_STACK}`;
  const spaceWidth = ctx.measureText(' ').width;
  lines.forEach((line, lineIndex) => {
    let x = boxX + pad;
    const y = textTop + lineIndex * lineHeight;
    ctx.fillStyle = '#ffffff';
    for (const word of line) {
      ctx.fillText(word.text, x, y);
      x += ctx.measureText(word.text).width + spaceWidth;
    }
  });

  // Divider + meta line.
  if (postMeta) {
    const metaY = textTop + textHeight + metaFontSize * 0.9;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(boxX + pad, metaY);
    ctx.lineTo(boxX + boxWidth - pad, metaY);
    ctx.stroke();
    ctx.font = `500 ${metaFontSize}px ${FONT_STACK}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fillText(postMeta, boxX + pad, metaY + metaFontSize * 0.7);
  }

  drawBottomStrips(ctx, width, height, options);
}

export function drawCard(canvas: HTMLCanvasElement, options: CardOptions) {
  const { width, height } = formatSizes[options.format];
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d') as CanvasCtx | null;
  if (!ctx) {
    return;
  }

  switch (options.template) {
    case 'quote':
      drawQuoteTemplate(ctx, width, height, options);
      break;
    case 'update':
      drawUpdateTemplate(ctx, width, height, options);
      break;
    case 'stat':
      drawStatTemplate(ctx, width, height, options);
      break;
    case 'recap':
      drawRecapTemplate(ctx, width, height, options);
      break;
    case 'post':
      drawPostTemplate(ctx, width, height, options);
      break;
    default:
      drawHeadlineTemplate(ctx, width, height, options);
  }
}
