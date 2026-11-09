// The one id every Videorc Cloud toast shares (plan 184), so a newer one
// replaces the older. Its own module: the eager Studio provider needs the id,
// and the toasts' words (`cloud-toasts.ts`) load lazily.
export const CLOUD_TOAST_ID = 'videorc-cloud'
