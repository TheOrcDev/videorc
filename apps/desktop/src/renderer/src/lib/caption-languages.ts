// The spoken languages live captions offer (Captions → Spoken language), in
// one place: the captions controls draw them and `update_settings` (plan 209
// S14, D16) accepts exactly these.
export const CAPTION_LANGUAGES = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Spanish' },
  { id: 'fr', label: 'French' },
  { id: 'de', label: 'German' },
  { id: 'pt', label: 'Portuguese' },
  { id: 'it', label: 'Italian' }
] as const
