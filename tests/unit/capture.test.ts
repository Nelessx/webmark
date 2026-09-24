import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import {
  arrayBufferToBase64,
  blobToDataUrl,
  captureElement,
  captureVisibleTab,
  cropRectToPixels,
  cropScreenshot,
  dataUrlToBlob,
  fitWithin,
  isCaptureQuotaError,
} from '@/lib/capture';

const IMAGE = { width: 1000, height: 800 };

describe('cropRectToPixels', () => {
  it('adds padding around the element at 1x', () => {
    expect(cropRectToPixels({ x: 100, y: 50, width: 200, height: 100 }, 1, IMAGE)).toEqual({
      x: 92,
      y: 42,
      width: 216,
      height: 116,
    });
  });

  it('scales CSS px to image px by devicePixelRatio (padding included)', () => {
    const image = { width: 2000, height: 1600 };
    expect(cropRectToPixels({ x: 100, y: 50, width: 200, height: 100 }, 2, image)).toEqual({
      x: 184,
      y: 84,
      width: 432,
      height: 232,
    });
  });

  it('rounds fractional edges outwards so the element is never clipped', () => {
    expect(cropRectToPixels({ x: 10.4, y: 10.6, width: 20.2, height: 20.2 }, 1.5, IMAGE, 0)).toEqual({
      x: 15,
      y: 15,
      width: 31,
      height: 32,
    });
  });

  it('clamps to the image bounds', () => {
    expect(cropRectToPixels({ x: -50, y: -20, width: 2000, height: 2000 }, 1, IMAGE)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 800,
    });
    expect(cropRectToPixels({ x: 950, y: 780, width: 200, height: 100 }, 1, IMAGE)).toEqual({
      x: 942,
      y: 772,
      width: 58,
      height: 28,
    });
  });

  it('returns undefined when the element is outside the screenshot', () => {
    expect(cropRectToPixels({ x: 100, y: 900, width: 50, height: 50 }, 1, IMAGE)).toBeUndefined();
    expect(cropRectToPixels({ x: -300, y: 10, width: 50, height: 50 }, 1, IMAGE)).toBeUndefined();
  });

  it('keeps a sliver that is only visible thanks to the padding', () => {
    expect(cropRectToPixels({ x: 100, y: 804, width: 50, height: 50 }, 1, IMAGE)).toEqual({
      x: 92,
      y: 796,
      width: 66,
      height: 4,
    });
  });

  it('treats an invalid devicePixelRatio as 1', () => {
    const rect = { x: 10, y: 10, width: 10, height: 10 };
    const expected = cropRectToPixels(rect, 1, IMAGE);
    expect(cropRectToPixels(rect, 0, IMAGE)).toEqual(expected);
    expect(cropRectToPixels(rect, Number.NaN, IMAGE)).toEqual(expected);
    expect(cropRectToPixels(rect, -2, IMAGE)).toEqual(expected);
  });

  it('rejects non-finite or negative rects', () => {
    expect(cropRectToPixels({ x: Number.NaN, y: 0, width: 10, height: 10 }, 1, IMAGE)).toBeUndefined();
    expect(cropRectToPixels({ x: 0, y: 0, width: Infinity, height: 10 }, 1, IMAGE)).toBeUndefined();
    expect(cropRectToPixels({ x: 0, y: 0, width: -5, height: 10 }, 1, IMAGE)).toBeUndefined();
  });
});

describe('fitWithin', () => {
  it('never upscales', () => {
    expect(fitWithin({ width: 300, height: 200 })).toEqual({ width: 300, height: 200 });
    expect(fitWithin({ width: 1200, height: 1200 })).toEqual({ width: 1200, height: 1200 });
  });

  it('scales the longest side down to the limit, keeping the aspect ratio', () => {
    expect(fitWithin({ width: 2400, height: 600 })).toEqual({ width: 1200, height: 300 });
    expect(fitWithin({ width: 500, height: 3000 })).toEqual({ width: 200, height: 1200 });
    expect(fitWithin({ width: 1000, height: 400 }, 500)).toEqual({ width: 500, height: 200 });
  });

  it('keeps at least 1 px on the short side', () => {
    expect(fitWithin({ width: 10000, height: 2 })).toEqual({ width: 1200, height: 1 });
  });
});

describe('base64 and data URLs', () => {
  it('encodes bytes like btoa, including buffers larger than one chunk', () => {
    const small = new Uint8Array([0, 1, 2, 250, 255]);
    expect(arrayBufferToBase64(small.buffer)).toBe(btoa(String.fromCharCode(...small)));

    const large = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    let binary = '';
    for (const byte of large) binary += String.fromCharCode(byte);
    expect(arrayBufferToBase64(large.buffer)).toBe(btoa(binary));
  });

  it('round-trips a base64 data URL through a Blob', async () => {
    const dataUrl = `data:image/png;base64,${btoa('\x89PNG\r\n\x1a\nhello')}`;
    const blob = dataUrlToBlob(dataUrl);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(13);
    expect(await blobToDataUrl(blob)).toBe(dataUrl);
  });

  it('decodes percent-encoded (non-base64) data URLs', async () => {
    const blob = dataUrlToBlob('data:text/plain,hello%20world');
    expect(blob.type).toBe('text/plain');
    expect(await blob.text()).toBe('hello world');
  });

  it('rejects strings that are not data URLs', () => {
    expect(() => dataUrlToBlob('https://example.com/a.png')).toThrow();
    expect(() => dataUrlToBlob('data:image/png;base64')).toThrow();
  });
});

describe('isCaptureQuotaError', () => {
  it("recognises Chrome's rate limit error", () => {
    expect(
      isCaptureQuotaError(new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.')),
    ).toBe(true);
    expect(isCaptureQuotaError(new Error('Cannot access contents of url "chrome://newtab/"'))).toBe(false);
    expect(isCaptureQuotaError('quota exceeded')).toBe(true);
  });
});

type CaptureFn = (windowId: number, options: { format: string }) => Promise<string>;

function mockCapture() {
  return vi.spyOn(browser.tabs as unknown as { captureVisibleTab: CaptureFn }, 'captureVisibleTab');
}

const QUOTA_ERROR = new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');

describe('captureVisibleTab', () => {
  it('captures a PNG of the given window', async () => {
    const spy = mockCapture().mockResolvedValue('data:image/png;base64,AAAA');
    await expect(captureVisibleTab(7, 0)).resolves.toBe('data:image/png;base64,AAAA');
    expect(spy).toHaveBeenCalledWith(7, { format: 'png' });
  });

  it('retries once after a rate-limit error', async () => {
    const spy = mockCapture().mockRejectedValueOnce(QUOTA_ERROR).mockResolvedValueOnce('data:image/png;base64,AAAA');
    await expect(captureVisibleTab(1, 0)).resolves.toBe('data:image/png;base64,AAAA');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second rate-limit error', async () => {
    const spy = mockCapture().mockRejectedValue(QUOTA_ERROR);
    await expect(captureVisibleTab(1, 0)).rejects.toThrow(/quota/);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not retry other errors', async () => {
    const spy = mockCapture().mockRejectedValue(new Error('Cannot access a chrome:// URL'));
    await expect(captureVisibleTab(1, 0)).rejects.toThrow(/chrome:\/\//);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// jsdom has no createImageBitmap / OffscreenCanvas, so stand-ins record what gets drawn.
function stubCanvas(image: { width: number; height: number }) {
  const drawImage = vi.fn();
  const close = vi.fn();
  const convertToBlob = vi.fn(async (options: { type: string; quality: number }) => {
    return new Blob(['jpeg-bytes'], { type: options.type });
  });
  const created: { width: number; height: number }[] = [];

  class FakeOffscreenCanvas {
    constructor(width: number, height: number) {
      created.push({ width, height });
    }
    getContext() {
      return { fillStyle: '', fillRect: vi.fn(), drawImage, imageSmoothingEnabled: false, imageSmoothingQuality: 'low' };
    }
    convertToBlob = convertToBlob;
  }

  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ ...image, close })));
  return { drawImage, close, convertToBlob, created };
}

const PNG_DATA_URL = `data:image/png;base64,${btoa('png')}`;

describe('cropScreenshot', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws the padded, scaled crop and encodes a JPEG', async () => {
    const canvas = stubCanvas({ width: 2000, height: 1600 });
    const dataUrl = await cropScreenshot(PNG_DATA_URL, { x: 100, y: 50, width: 200, height: 100 }, 2);

    expect(canvas.created).toEqual([{ width: 432, height: 232 }]);
    expect(canvas.drawImage).toHaveBeenCalledWith(expect.anything(), 184, 84, 432, 232, 0, 0, 432, 232);
    expect(canvas.convertToBlob).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.85 });
    expect(dataUrl).toBe(`data:image/jpeg;base64,${btoa('jpeg-bytes')}`);
    expect(canvas.close).toHaveBeenCalled();
  });

  it('downscales large crops so the longest side is 1200 px', async () => {
    const canvas = stubCanvas({ width: 3000, height: 2000 });
    await cropScreenshot(PNG_DATA_URL, { x: 8, y: 8, width: 2384, height: 584 }, 1);

    expect(canvas.created).toEqual([{ width: 1200, height: 300 }]);
    expect(canvas.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2400, 600, 0, 0, 1200, 300);
  });

  it('fails (and frees the bitmap) when the element is off-screen', async () => {
    const canvas = stubCanvas({ width: 1000, height: 800 });
    await expect(cropScreenshot(PNG_DATA_URL, { x: 0, y: 5000, width: 10, height: 10 }, 1)).rejects.toThrow(
      /not inside the visible part/,
    );
    expect(canvas.drawImage).not.toHaveBeenCalled();
    expect(canvas.close).toHaveBeenCalled();
  });
});

describe('captureElement', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the cropped JPEG', async () => {
    stubCanvas({ width: 1000, height: 800 });
    mockCapture().mockResolvedValue(PNG_DATA_URL);
    const result = await captureElement(3, { x: 10, y: 10, width: 50, height: 50 }, 1);
    expect(result).toEqual({ dataUrl: `data:image/jpeg;base64,${btoa('jpeg-bytes')}` });
  });

  it('returns an error instead of throwing', async () => {
    mockCapture().mockRejectedValue(new Error('Missing host permission for the tab'));
    await expect(captureElement(3, { x: 0, y: 0, width: 10, height: 10 }, 1)).resolves.toEqual({
      error: 'Missing host permission for the tab',
    });
  });
});
