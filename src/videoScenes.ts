// Scene renderers for the multi-scene story video. Deliberately SELF-CONTAINED so the card /
// PNG rendering in cardEngine.ts stays untouched — the only thing reused from there is the
// public drawCard() (for the hero scene) and formatSizes. Beat/close slides are drawn here.
import type { CardOptions } from './cardEngine';
import { drawCard, formatSizes } from './cardEngine';

const FONT_STACK = "'Poppins', 'IBM Plex Sans', sans-serif";
const BG = '#060606';

type Ctx = CanvasRenderingContext2D & { letterSpacing?: string };

export type SceneKind = 'hero' | 'beat-photo' | 'beat-brand' | 'cta';
export type VideoScene = { bitmap: HTMLCanvasElement; durationMs: number; kind: SceneKind };

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPhotoCover(ctx: Ctx, photo: HTMLImageElement, width: number, height: number) {
  const scale = Math.max(width / photo.width, height / photo.height);
  const drawnWidth = photo.width * scale;
  const drawnHeight = photo.height * scale;
  ctx.drawImage(photo, (width - drawnWidth) / 2, (height - drawnHeight) * 0.3, drawnWidth, drawnHeight);
}

function drawPlaceholder(ctx: Ctx, width: number, height: number) {
  const glow = ctx.createRadialGradient(width * 0.5, height * 0.35, 0, width * 0.5, height * 0.35, width * 0.7);
  glow.addColorStop(0, 'rgba(243, 196, 87, 0.18)');
  glow.addColorStop(1, 'rgba(243, 196, 87, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
}

function drawBrandStrip(ctx: Ctx, width: number, y: number) {
  const fontSize = Math.round(width * 0.028);
  ctx.font = `700 ${fontSize}px ${FONT_STACK}`;
  ctx.letterSpacing = `${Math.round(fontSize * 0.28)}px`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.66)';
  const brand = 'GREATERNEWS';
  ctx.fillText(brand, width / 2, y);
  const brandWidth = ctx.measureText(brand).width;
  ctx.letterSpacing = '0px';

  const ruleLength = Math.round(width * 0.055);
  const ruleY = y + fontSize * 0.55;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(width / 2 - brandWidth / 2 - 28 - ruleLength, ruleY);
  ctx.lineTo(width / 2 - brandWidth / 2 - 28, ruleY);
  ctx.moveTo(width / 2 + brandWidth / 2 + 28, ruleY);
  ctx.lineTo(width / 2 + brandWidth / 2 + 28 + ruleLength, ruleY);
  ctx.stroke();
}

function drawGnBadge(ctx: Ctx, width: number, logo: HTMLImageElement | null) {
  const size = Math.round(width * 0.085);
  const margin = Math.round(width * 0.055);
  const x = width - margin - size;
  const y = margin;

  roundRect(ctx, x, y, size, size, Math.round(size * 0.22));
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = Math.max(3, Math.round(width * 0.004));
  ctx.stroke();

  if (logo) {
    const pad = Math.round(size * 0.16);
    const inner = size - pad * 2;
    const scale = Math.min(inner / logo.width, inner / logo.height);
    const drawnWidth = logo.width * scale;
    const drawnHeight = logo.height * scale;
    ctx.drawImage(logo, x + (size - drawnWidth) / 2, y + (size - drawnHeight) / 2, drawnWidth, drawnHeight);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${Math.round(size * 0.42)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('GN', x + size / 2, y + size / 2 + size * 0.03);
  }
}

function wrapLines(ctx: Ctx, words: string[], maxWidth: number) {
  const spaceWidth = ctx.measureText(' ').width;
  const lines: string[] = [];
  let line: string[] = [];
  let width = 0;
  for (const word of words) {
    const wordWidth = ctx.measureText(word).width;
    const extra = line.length > 0 ? spaceWidth : 0;
    if (line.length > 0 && width + extra + wordWidth > maxWidth) {
      lines.push(line.join(' '));
      line = [word];
      width = wordWidth;
    } else {
      line.push(word);
      width += extra + wordWidth;
    }
  }
  if (line.length > 0) {
    lines.push(line.join(' '));
  }
  return lines;
}

// Shrink the font until the wrapped text fits maxLines and maxHeight.
function fitText(
  ctx: Ctx,
  text: string,
  opts: { maxWidth: number; maxHeight: number; baseFont: number; minFont: number; maxLines: number; weight: number; factor: number },
) {
  const words = text.split(/\s+/).filter(Boolean);
  let fontSize = opts.baseFont;
  let lines: string[] = [];
  while (fontSize >= opts.minFont) {
    ctx.font = `${opts.weight} ${fontSize}px ${FONT_STACK}`;
    lines = wrapLines(ctx, words, opts.maxWidth);
    if (lines.length <= opts.maxLines && lines.length * fontSize * opts.factor <= opts.maxHeight) {
      break;
    }
    fontSize -= 4;
  }
  return { lines, fontSize, lineHeight: fontSize * opts.factor, height: lines.length * fontSize * opts.factor };
}

function paintCentered(ctx: Ctx, lines: string[], width: number, top: number, fontSize: number, lineHeight: number, weight: number, color: string) {
  ctx.font = `${weight} ${fontSize}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  lines.forEach((line, index) => ctx.fillText(line, width / 2, top + index * lineHeight));
}

function accentUnderline(ctx: Ctx, width: number, y: number, accent: string) {
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(4, Math.round(width * 0.006));
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(width / 2 - Math.round(width * 0.06), y);
  ctx.lineTo(width / 2 + Math.round(width * 0.06), y);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

// A story beat shown over the (further-dimmed) story photo.
function renderBeatPhoto(options: CardOptions, text: string, width: number, height: number) {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d') as Ctx;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);
  if (options.photo) {
    drawPhotoCover(ctx, options.photo, width, height);
  } else {
    drawPlaceholder(ctx, width, height);
  }
  // Darken for legibility, plus a stronger gradient toward the text band.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.fillRect(0, 0, width, height);
  const fade = ctx.createLinearGradient(0, height * 0.35, 0, height);
  fade.addColorStop(0, 'rgba(6, 6, 6, 0)');
  fade.addColorStop(1, 'rgba(6, 6, 6, 0.88)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, height * 0.35, width, height * 0.65);

  drawGnBadge(ctx, width, options.logo);
  drawBrandStrip(ctx, width, Math.round(height * 0.1));

  const fit = fitText(ctx, text, {
    maxWidth: width * 0.84,
    maxHeight: height * 0.5,
    baseFont: Math.round(width * 0.075),
    minFont: Math.round(width * 0.045),
    maxLines: 4,
    weight: 800,
    factor: 1.18,
  });
  const top = (height - fit.height) / 2 + Math.round(height * 0.06);
  paintCentered(ctx, fit.lines, width, top, fit.fontSize, fit.lineHeight, 800, '#ffffff');
  accentUnderline(ctx, width, top + fit.height + Math.round(height * 0.022), options.accent);
  return canvas;
}

// A story beat on the brand background (no photo).
function renderBeatBrand(options: CardOptions, text: string, width: number, height: number) {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d') as Ctx;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(width * 0.5, height * 0.32, 0, width * 0.5, height * 0.32, width * 0.75);
  glow.addColorStop(0, 'rgba(243, 196, 87, 0.09)');
  glow.addColorStop(1, 'rgba(243, 196, 87, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  drawGnBadge(ctx, width, options.logo);
  drawBrandStrip(ctx, width, Math.round(height * 0.12));

  const fit = fitText(ctx, text, {
    maxWidth: width * 0.82,
    maxHeight: height * 0.5,
    baseFont: Math.round(width * 0.082),
    minFont: Math.round(width * 0.05),
    maxLines: 4,
    weight: 800,
    factor: 1.18,
  });
  const top = (height - fit.height) / 2;
  paintCentered(ctx, fit.lines, width, top, fit.fontSize, fit.lineHeight, 800, '#ffffff');
  accentUnderline(ctx, width, top + fit.height + Math.round(height * 0.03), options.accent);
  return canvas;
}

// Closing card: brand mark + follow call-to-action + source line.
function renderCta(options: CardOptions, width: number, height: number) {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d') as Ctx;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(width * 0.5, height * 0.42, 0, width * 0.5, height * 0.42, width * 0.7);
  glow.addColorStop(0, 'rgba(243, 196, 87, 0.1)');
  glow.addColorStop(1, 'rgba(243, 196, 87, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // Centered badge.
  const size = Math.round(width * 0.2);
  const bx = (width - size) / 2;
  const by = Math.round(height * 0.28);
  roundRect(ctx, bx, by, size, size, Math.round(size * 0.22));
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = Math.max(3, Math.round(width * 0.005));
  ctx.stroke();
  if (options.logo) {
    const pad = Math.round(size * 0.18);
    const inner = size - pad * 2;
    const scale = Math.min(inner / options.logo.width, inner / options.logo.height);
    ctx.drawImage(options.logo, bx + (size - options.logo.width * scale) / 2, by + (size - options.logo.height * scale) / 2, options.logo.width * scale, options.logo.height * scale);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${Math.round(size * 0.42)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('GN', width / 2, by + size / 2 + size * 0.03);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 ${Math.round(width * 0.072)}px ${FONT_STACK}`;
  ctx.fillText('Follow GreaterNews', width / 2, by + size + Math.round(height * 0.03));

  ctx.fillStyle = options.accent;
  ctx.font = `700 ${Math.round(width * 0.045)}px ${FONT_STACK}`;
  ctx.fillText('News You Can Trust', width / 2, by + size + Math.round(height * 0.1));

  const source = options.footer.trim();
  if (source) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = `500 ${Math.round(width * 0.024)}px ${FONT_STACK}`;
    ctx.fillText(source.length > 70 ? `${source.slice(0, 69)}…` : source, width / 2, height - Math.round(height * 0.08));
  }
  return canvas;
}

// Build the full scene list. No beats → a single hero scene (today's behavior, unchanged).
export function buildScenes(options: CardOptions, beats: string[]): VideoScene[] {
  const { width, height } = formatSizes[options.format];
  const hero = makeCanvas(width, height);
  drawCard(hero, options);

  const clean = beats.map((beat) => beat.trim()).filter(Boolean).slice(0, 6);
  if (clean.length === 0) {
    return [{ bitmap: hero, durationMs: 7000, kind: 'hero' }];
  }

  const scenes: VideoScene[] = [{ bitmap: hero, durationMs: 3500, kind: 'hero' }];
  clean.forEach((text, index) => {
    const onPhoto = index % 2 === 0 && options.photo !== null;
    scenes.push({
      bitmap: onPhoto ? renderBeatPhoto(options, text, width, height) : renderBeatBrand(options, text, width, height),
      durationMs: 3200,
      kind: onPhoto ? 'beat-photo' : 'beat-brand',
    });
  });
  scenes.push({ bitmap: renderCta(options, width, height), durationMs: 2600, kind: 'cta' });
  return scenes;
}
