import { browser } from 'wxt/browser';
import type { CaptureResult, ViewportRect } from './messages';

/*
 * Element screenshots: capture the visible tab, crop it to the element and
 * shrink it to a small JPEG. Runs in the background (a service worker on
 * Chromium MV3, so no DOM; an event page with a DOM on Firefox MV2).
 */

/** Extra room around the element, in CSS px, so its edges stay visible. */
export const CROP_PADDING_CSS_PX = 8;
/** Longest side of the stored screenshot, in image px. */
export const MAX_SCREENSHOT_SIDE_PX = 1200;
export const JPEG_QUALITY = 0.85;
/** Chrome allows ~2 captureVisibleTab calls per second per extension. */
export const QUOTA_RETRY_DELAY_MS = 600;

/** A rectangle in image pixels (integers). */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Pure geometry
// ---------------------------------------------------------------------------

function sanitizeScale(devicePixelRatio: number): number {
  return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
}

/**
 * Convert an element's viewport rect (CSS px) into the pixel rect to cut out
 * of a screenshot of `image` size, with padding, clamped to the image.
 * Returns undefined when nothing of the element is inside the screenshot.
 */
export function cropRectToPixels(
  rect: ViewportRect,
  devicePixelRatio: number,
  image: Size,
  paddingCssPx = CROP_PADDING_CSS_PX,
): PixelRect | undefined {
  const values = [rect.x, rect.y, rect.width, rect.height, paddingCssPx];
  if (!values.every(Number.isFinite) || rect.width < 0 || rect.height < 0) return undefined;

  const scale = sanitizeScale(devicePixelRatio);
  const pad = Math.max(0, paddingCssPx);
  const left = Math.max(0, Math.floor((rect.x - pad) * scale));
  const top = Math.max(0, Math.floor((rect.y - pad) * scale));
  const right = Math.min(image.width, Math.ceil((rect.x + rect.width + pad) * scale));
  const bottom = Math.min(image.height, Math.ceil((rect.y + rect.height + pad) * scale));

  if (right - left < 1 || bottom - top < 1) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Scale `size` down (never up) so its longest side is at most `maxSide`. */
export function fitWithin(size: Size, maxSide = MAX_SCREENSHOT_SIDE_PX): Size {
  const longest = Math.max(size.width, size.height);
  if (longest <= maxSide) return { width: size.width, height: size.height };
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

// ---------------------------------------------------------------------------
// Data URL <-> Blob (no FileReader or fetch needed, so it works in workers)
// ---------------------------------------------------------------------------

const BASE64_CHUNK = 0x8000;

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked because String.fromCharCode(...hugeArray) overflows the call stack.
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const base64 = arrayBufferToBase64(await blob.arrayBuffer());
  return `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) throw new Error('Not a data URL');
  const meta = dataUrl.slice('data:'.length, comma);
  const payload = dataUrl.slice(comma + 1);
  const type = meta.split(';')[0] || 'application/octet-stream';

  if (!/;base64$/i.test(meta)) {
    return new Blob([decodeURIComponent(payload)], { type });
  }
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function drawCrop(ctx: Context2D, source: CanvasImageSource, crop: PixelRect, out: Size): void {
  // JPEG has no alpha: paint white so transparent pixels don't turn black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, out.width, out.height);
}

async function renderWithOffscreenCanvas(
  source: CanvasImageSource,
  crop: PixelRect,
  out: Size,
  quality: number,
): Promise<string | undefined> {
  if (typeof OffscreenCanvas === 'undefined') return undefined;
  const canvas = new OffscreenCanvas(out.width, out.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  drawCrop(ctx, source, crop, out);
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality }));
}

/** Firefox MV2 event pages have a DOM; used if OffscreenCanvas is missing. */
function renderWithDomCanvas(source: CanvasImageSource, crop: PixelRect, out: Size, quality: number): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = out.width;
  canvas.height = out.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  drawCrop(ctx, source, crop, out);
  return canvas.toDataURL('image/jpeg', quality);
}

export interface CropOptions {
  paddingCssPx?: number;
  maxSide?: number;
  quality?: number;
}

/**
 * Crop a screenshot (data URL) to an element's viewport rect and return a
 * downscaled JPEG data URL. Throws if the element is outside the screenshot or
 * no canvas is available.
 */
export async function cropScreenshot(
  screenshotDataUrl: string,
  rect: ViewportRect,
  devicePixelRatio: number,
  options: CropOptions = {},
): Promise<string> {
  const { paddingCssPx = CROP_PADDING_CSS_PX, maxSide = MAX_SCREENSHOT_SIDE_PX, quality = JPEG_QUALITY } = options;
  if (typeof createImageBitmap !== 'function') throw new Error('Image decoding is not supported here');

  const bitmap = await createImageBitmap(dataUrlToBlob(screenshotDataUrl));
  try {
    const crop = cropRectToPixels(rect, devicePixelRatio, bitmap, paddingCssPx);
    if (!crop) throw new Error('The element is not inside the visible part of the page');
    const out = fitWithin(crop, maxSide);
    const dataUrl =
      (await renderWithOffscreenCanvas(bitmap, crop, out, quality)) ??
      renderWithDomCanvas(bitmap, crop, out, quality);
    if (!dataUrl) throw new Error('No canvas is available to crop the screenshot');
    return dataUrl;
  } finally {
    bitmap.close();
  }
}

// ---------------------------------------------------------------------------
// Capturing
// ---------------------------------------------------------------------------

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Chrome: "This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota." */
export function isCaptureQuotaError(error: unknown): boolean {
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(errorMessage(error));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** PNG data URL of the visible part of the active tab in `windowId`, retrying once on Chrome's rate limit. */
export async function captureVisibleTab(windowId: number, retryDelayMs = QUOTA_RETRY_DELAY_MS): Promise<string> {
  try {
    return await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (error) {
    if (!isCaptureQuotaError(error)) throw error;
    await sleep(retryDelayMs);
    return browser.tabs.captureVisibleTab(windowId, { format: 'png' });
  }
}

/** Capture + crop in one step. Never throws: failures come back as `{ error }`. */
export async function captureElement(
  windowId: number,
  rect: ViewportRect,
  devicePixelRatio: number,
  options: CropOptions & { retryDelayMs?: number } = {},
): Promise<CaptureResult> {
  try {
    const screenshot = await captureVisibleTab(windowId, options.retryDelayMs);
    return { dataUrl: await cropScreenshot(screenshot, rect, devicePixelRatio, options) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}
