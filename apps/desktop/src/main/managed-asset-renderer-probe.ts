export type ManagedImageDecodeResult = {
  url: string
  naturalWidth: number
  naturalHeight: number
}

export function managedImageDecodeScript(url: string, timeoutMs = 8_000): string {
  const safeTimeoutMs = Math.max(1, Math.min(30_000, Math.round(timeoutMs)))
  return `(() => new Promise((resolve, reject) => {
    const image = new Image();
    const timer = window.setTimeout(() => reject(new Error('Managed image decode timed out.')), ${safeTimeoutMs});
    image.onload = () => {
      window.clearTimeout(timer);
      resolve({ url: image.currentSrc || image.src, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight });
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('Managed image failed to decode.'));
    };
    image.src = ${JSON.stringify(url)};
  }))()`
}

export function normalizeManagedImageDecodeResult(
  value: unknown,
  expectedUrl: string
): ManagedImageDecodeResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Managed image decode returned an invalid result.')
  }
  const result = value as Record<string, unknown>
  if (
    result.url !== expectedUrl ||
    typeof result.naturalWidth !== 'number' ||
    !Number.isSafeInteger(result.naturalWidth) ||
    result.naturalWidth < 1 ||
    typeof result.naturalHeight !== 'number' ||
    !Number.isSafeInteger(result.naturalHeight) ||
    result.naturalHeight < 1
  ) {
    throw new Error('Managed image protocol did not decode the expected asset dimensions.')
  }
  return {
    url: expectedUrl,
    naturalWidth: result.naturalWidth,
    naturalHeight: result.naturalHeight
  }
}
