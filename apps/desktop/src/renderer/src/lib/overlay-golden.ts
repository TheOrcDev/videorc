// Plan 260 S1.2 (plan 220's goldens, ported from videorc-rust): the golden
// source for the backend's overlay rasteriser. `scripts/overlay-raster-
// goldens.mjs` imports this module in the dev app through the `eval-js` smoke
// command (dev server only, never the app's own bundle) and gets the PNG the
// renderer's own painter sends for one overlay state: the caption bar
// (`captions.overlay.set`), the captioned copy's cue frame, the highlight
// card and the milestone card (`comments.highlight.set`) and the chat box
// (`chat.overlay.set`). Each case calls the production function with the
// production defaults. The platforms' own marks (YouTube's icon, X's mark and
// checks) are the bundled files; an avatar or emote is decoded from the bytes
// the case sends in `images` (by the URL the card reads it for), never
// fetched. The script writes the answers to
// `crates/videorc-backend/tests/fixtures/overlay-raster/`.

import type {
  CaptionStyleId,
  LiveChatAuthorVerified,
  LiveChatMessage,
  LiveChatMessageFragment,
  OverlayRect,
  StreamPlatform
} from '@/lib/backend'
import type { CaptionPosition, CaptionTextSize } from '@/lib/caption-overlay'

/** An image file a case draws: base64 bytes by the URL the card reads. */
type GoldenImages = Record<string, string>

export type OverlayGoldenRequest =
  | {
      overlay: 'caption'
      text: string
      canvasWidth: number
      canvasHeight?: number
      textSize: CaptionTextSize
      styleId: CaptionStyleId
      maxBarWidthPx?: number
    }
  | {
      overlay: 'captionFrame'
      text: string
      canvasWidth: number
      canvasHeight: number
      position: CaptionPosition
      textSize: CaptionTextSize
      styleId: CaptionStyleId
    }
  | {
      overlay: 'highlight'
      authorName: string
      text: string
      fragments?: LiveChatMessageFragment[]
      platform: StreamPlatform
      avatarUrl?: string
      authorVerified?: LiveChatAuthorVerified
      canvasWidth: number
      canvasHeight: number
      rect?: OverlayRect
      images?: GoldenImages
    }
  | {
      overlay: 'milestone'
      name: string
      label: string
      personaName?: string
      platform: StreamPlatform
      avatarUrl?: string
      canvasWidth: number
      canvasHeight: number
      rect?: OverlayRect
      images?: GoldenImages
    }
  | {
      overlay: 'chat'
      messages: Array<{
        authorName: string
        platform: StreamPlatform
        text: string
        fragments?: LiveChatMessageFragment[]
      }>
      canvasWidth: number
      canvasHeight: number
      rect: OverlayRect
      images?: GoldenImages
    }

/** A chat message as the providers deliver it: the text as one fragment
 * unless the case gives its fragments. */
function goldenMessage(
  index: number,
  authorName: string,
  platform: StreamPlatform,
  text: string,
  extra: {
    fragments?: LiveChatMessageFragment[]
    authorAvatarUrl?: string
    authorVerified?: LiveChatAuthorVerified
  } = {}
): LiveChatMessage {
  return {
    id: `golden-${index}`,
    providerMessageId: `golden-${index}`,
    platform,
    sessionId: 'golden-session',
    authorName,
    ...(extra.authorAvatarUrl ? { authorAvatarUrl: extra.authorAvatarUrl } : {}),
    ...(extra.authorVerified ? { authorVerified: extra.authorVerified } : {}),
    authorBadges: [],
    authorRoles: [],
    publishedAt: '2026-11-09T12:00:00.000Z',
    receivedAt: '2026-11-09T12:00:00.000Z',
    messageText: text,
    fragments: extra.fragments ?? [{ type: 'text', text }],
    eventType: 'message',
    isDeleted: false
  }
}

const GOLDEN_IMAGE_PREFIX = 'golden-image:'

/** The card's image readers over the case's own bytes: a URL the case does
 * not name is never cached (the card then draws the monogram or the emote's
 * name), and nothing is fetched. */
function goldenImages(images: GoldenImages = {}) {
  return {
    cacheImage: async (remoteUrl: string) =>
      images[remoteUrl] ? `${GOLDEN_IMAGE_PREFIX}${remoteUrl}` : null,
    readImage: async (localUrl: string) => {
      const bytes = images[localUrl.slice(GOLDEN_IMAGE_PREFIX.length)]
      return bytes ? Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0)) : null
    },
    warn: () => {}
  }
}

/** The PNG (base64, no data: prefix) the renderer sends for this state, or
 * null where the renderer sends nothing (empty text, no room). */
export async function renderOverlayGoldenPng(
  request: OverlayGoldenRequest
): Promise<{ pngBase64: string | null }> {
  switch (request.overlay) {
    case 'caption': {
      const { renderCaptionOverlayPng } = await import('@/lib/caption-overlay')
      return {
        pngBase64: await renderCaptionOverlayPng({
          text: request.text,
          canvasWidth: request.canvasWidth,
          canvasHeight: request.canvasHeight,
          textSize: request.textSize,
          styleId: request.styleId,
          maxBarWidthPx: request.maxBarWidthPx
        })
      }
    }
    case 'captionFrame': {
      const { renderCaptionCueFramePng } = await import('@/lib/caption-overlay')
      return {
        pngBase64: await renderCaptionCueFramePng({
          text: request.text,
          canvasWidth: request.canvasWidth,
          canvasHeight: request.canvasHeight,
          position: request.position,
          textSize: request.textSize,
          styleId: request.styleId
        })
      }
    }
    case 'highlight': {
      const { renderCommentHighlightCards } = await import('@/lib/caption-overlay')
      const images = goldenImages(request.images)
      const cards = await renderCommentHighlightCards(
        goldenMessage(0, request.authorName, request.platform, request.text, {
          fragments: request.fragments,
          authorAvatarUrl: request.avatarUrl,
          authorVerified: request.authorVerified
        }),
        request.avatarUrl ? await images.cacheImage(request.avatarUrl) : null,
        { width: request.canvasWidth, height: request.canvasHeight, rect: request.rect },
        undefined,
        images
      )
      return { pngBase64: cards?.pngBase64 ?? null }
    }
    case 'milestone': {
      const { renderMilestoneCards } = await import('@/lib/caption-overlay')
      const images = goldenImages(request.images)
      const cards = await renderMilestoneCards(
        {
          messageId: 'golden-0',
          name: request.name,
          ...(request.avatarUrl ? { avatarUrl: request.avatarUrl } : {}),
          platform: request.platform,
          label: request.label
        },
        request.avatarUrl ? await images.cacheImage(request.avatarUrl) : null,
        request.personaName ?? null,
        { width: request.canvasWidth, height: request.canvasHeight, rect: request.rect },
        undefined,
        images
      )
      return { pngBase64: cards?.pngBase64 ?? null }
    }
    case 'chat': {
      const { renderChatOverlayCards } = await import('@/lib/caption-overlay')
      const cards = await renderChatOverlayCards(
        request.messages.map((message, index) =>
          goldenMessage(index, message.authorName, message.platform, message.text, {
            fragments: message.fragments
          })
        ),
        { width: request.canvasWidth, height: request.canvasHeight, rect: request.rect },
        undefined,
        goldenImages(request.images)
      )
      return { pngBase64: cards?.pngBase64 ?? null }
    }
  }
}
