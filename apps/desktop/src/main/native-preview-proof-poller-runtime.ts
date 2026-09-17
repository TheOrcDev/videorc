/**
 * Browser-side helpers injected into the detached Windows proof surface.
 *
 * Keeping the state transitions in one executable snippet lets the Node test
 * run the same code that Electron evaluates inside the proof window.
 */
export const NATIVE_PREVIEW_PROOF_POLLER_RUNTIME_SCRIPT = String.raw`
function stopLayerPoller(id, options = {}) {
  const existingPoller = pollers.get(id);
  if (!existingPoller) {
    pollers.delete(id);
    return null;
  }

  existingPoller.cancelled = true;
  existingPoller.abortController?.abort();
  const preserveFrame = options.preserveFrame === true;
  const preservedFrame = preserveFrame
    ? {
        objectUrl: existingPoller.objectUrl,
        startedAt: existingPoller.startedAt,
        lastFrameAdvanceAt: existingPoller.lastFrameAdvanceAt,
        lastTransportSuccessAt: existingPoller.lastTransportSuccessAt
      }
    : null;

  if (!preserveFrame && existingPoller.objectUrl) {
    if (existingPoller.image.src === existingPoller.objectUrl) {
      existingPoller.image.removeAttribute('src');
      existingPoller.image.dataset.live = '0';
    }
    URL.revokeObjectURL(existingPoller.objectUrl);
  }
  pollers.delete(id);
  return preservedFrame;
}

function markProofPollerTransportSuccess(poller, now) {
  poller.lastTransportSuccessAt = now;
}

function markProofPollerFrameAdvance(poller, now) {
  poller.lastTransportSuccessAt = now;
  poller.lastFrameAdvanceAt = now;
}

// Transport accounting (issue #157): the proof surface is a production
// preview transport on Windows, so its request rate, payload bytes, and
// decoded source dimensions must be observable instead of inferred.
function markProofPollerRequestStarted(poller) {
  poller.requestCount = (poller.requestCount ?? 0) + 1;
}

function markProofPollerNotModified(poller) {
  poller.notModifiedCount = (poller.notModifiedCount ?? 0) + 1;
}

function markProofPollerFrameDecoded(poller, byteLength, width, height, now) {
  poller.bytesReceived = (poller.bytesReceived ?? 0) +
    (Number.isFinite(byteLength) && byteLength > 0 ? byteLength : 0);
  poller.decodedFrames = (poller.decodedFrames ?? 0) + 1;
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    poller.lastFrameWidth = width;
    poller.lastFrameHeight = height;
  }
  poller.lastDecodeAt = now;
}

function proofPollerTransportTotals(activePollers) {
  let requestCount = 0;
  let notModifiedCount = 0;
  let bytesReceived = 0;
  let decodedFrames = 0;
  const sourceDimensions = {};
  for (const [id, poller] of activePollers) {
    requestCount += poller.requestCount ?? 0;
    notModifiedCount += poller.notModifiedCount ?? 0;
    bytesReceived += poller.bytesReceived ?? 0;
    decodedFrames += poller.decodedFrames ?? 0;
    if (poller.lastFrameWidth != null && poller.lastFrameHeight != null) {
      sourceDimensions[id] = {
        width: poller.lastFrameWidth,
        height: poller.lastFrameHeight
      };
    }
  }
  return { requestCount, notModifiedCount, bytesReceived, decodedFrames, sourceDimensions };
}

function presentProofPollerFrame(poller, objectUrl) {
  const previousObjectUrl = poller.objectUrl;
  poller.image.src = objectUrl;
  poller.image.dataset.live = '1';
  poller.objectUrl = objectUrl;
  if (previousObjectUrl && previousObjectUrl !== objectUrl) {
    URL.revokeObjectURL(previousObjectUrl);
  }
}

function proofImageIsBlank(image) {
  if (!image || image.naturalWidth < 1 || image.naturalHeight < 1) {
    return true;
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return true;
    }
    context.clearRect(0, 0, 8, 8);
    context.drawImage(image, 0, 0, 8, 8);
    const pixels = context.getImageData(0, 0, 8, 8).data;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] > 0) {
        return false;
      }
    }
    return true;
  } catch {
    // An unreadable frame cannot prove that a visible picture was decoded.
    return true;
  }
}

function proofPollerFrameAgeMs(poller, now) {
  return Math.max(0, now - (poller.lastFrameAdvanceAt ?? poller.startedAt));
}

function proofPollerTransportAgeMs(poller, now) {
  return Math.max(0, now - (poller.lastTransportSuccessAt ?? poller.startedAt));
}

function proofPollerFrameIsFresh(poller, now, freshnessBudgetMs) {
  return poller.lastFrameAdvanceAt != null &&
    proofPollerFrameAgeMs(poller, now) <= freshnessBudgetMs;
}

function proofPollersHaveCompleteFrameHistory(activePollers) {
  return activePollers.size > 0 &&
    [...activePollers.values()].every((poller) => poller.lastFrameAdvanceAt != null);
}

function proofPollerTransportIsFresh(poller, now, freshnessBudgetMs) {
  return poller.lastTransportSuccessAt != null &&
    proofPollerTransportAgeMs(poller, now) <= freshnessBudgetMs;
}
`
