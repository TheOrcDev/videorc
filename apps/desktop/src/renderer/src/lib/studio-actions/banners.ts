// Banners (plan 186 S7): by id, through the backend's own explicit show and
// hide; `bannerToggle` picks its verb from the list the remotes are shown, and
// `bannerHide` without an id hides them all.

import { runBannerAction } from '@/lib/banners'
import type { BannerRelayAction } from '../../../../shared/banner-commands'
import type {
  StudioActionContext,
  StudioActionExecutor,
  StudioActionFields,
  StudioActionOutcome
} from './context'
import { REMOTE_INTENT_COPY } from './copy'

async function runBannerIntent(
  context: StudioActionContext,
  verb: 'show' | 'hide' | 'toggle',
  fields: StudioActionFields
): Promise<StudioActionOutcome> {
  const bannerId = typeof fields.bannerId === 'string' ? fields.bannerId : undefined
  const banner = context.banners.find((candidate) => candidate.id === bannerId)
  if (bannerId !== undefined ? !banner : verb !== 'hide') {
    return { ok: false, message: REMOTE_INTENT_COPY.bannerMissing }
  }
  const action: BannerRelayAction = !banner
    ? { action: 'hideAll' }
    : verb === 'show' || (verb === 'toggle' && !banner.shown)
      ? { action: 'show', id: banner.id }
      : { action: 'hide', id: banner.id }
  return runBannerAction(context.client, action, context.banners)
}

export const bannerShow: StudioActionExecutor = (context, fields) =>
  runBannerIntent(context, 'show', fields)
export const bannerHide: StudioActionExecutor = (context, fields) =>
  runBannerIntent(context, 'hide', fields)
export const bannerToggle: StudioActionExecutor = (context, fields) =>
  runBannerIntent(context, 'toggle', fields)
