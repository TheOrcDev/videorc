// The Buddy onboarding and library copy (plan 170 D14), word for word from
// `docs/buddy-onboarding-copy.md`, the one source the web
// (`lib/buddy-onboarding-copy.ts` on videorc-web) and the app share. Change a
// string in that document first, then here; a test pins the four step titles
// and checks every string below appears in the document verbatim.
//
// `{name}`, `{remaining}`, `{limit}` and `{count}` are filled in by the
// helpers at the bottom. Pure strings: safe for any chunk.

export const BUDDY_ONBOARDING_STEP_COUNT = 4

/** The four step titles, in order (pinned by tests on both sides). */
export const BUDDY_ONBOARDING_STEP_TITLES = [
  'Meet your sidekick',
  'Describe it',
  'Give it a personality',
  'Create your Buddy'
] as const

export const BUDDY_ONBOARDING_BUTTONS = {
  back: 'Back',
  next: 'Next',
  /** Step 3 only, when Name is filled. */
  skip: 'Skip for now'
} as const

export const BUDDY_ONBOARDING_STEP1 = {
  lead: 'Create your own Golem, Orc, Goblin, Pirate, Robot, or anything you can describe, and put it in your live stream.',
  demoHeading: 'How it looks on stream',
  /** Appears just before the first bubble. */
  demoChip: 'New follower: Mira',
  /** In order: talk, talk, laugh; the idle pose between them. */
  demoBubbles: [
    'Welcome to the horde, Mira!',
    'We go live every Tuesday at 8, coders_x.',
    'Ha! Good one.'
  ],
  whatItDoesHeading: 'What it does',
  whatItDoes: [
    'Greets followers, subs and raids by name',
    "Answers viewers' questions from what you tell it",
    'Talks in a comic speech bubble, no voice needed',
    'Shows on your stream, in your recordings, or both',
    'Comes alive with Make it Alive'
  ],
  galleryHeading: 'Start from one of ours',
  galleryNote: 'Free for everyone.',
  cardAction: 'Use this one',
  primary: 'Create my own',
  premiumNote: 'Creating your own is part of Videorc Premium.'
} as const

export const BUDDY_ONBOARDING_STEP2 = {
  label: 'What does it look like?',
  placeholder: 'A grumpy stone golem with a mossy back and a lantern',
  examples: ['A tiny dragon in a hoodie', 'A knight made of pizza', 'A wise old owl with glasses'],
  pictureLabel: 'Add a picture for inspiration (optional)',
  pictureHelp:
    'A pet, a logo, a sketch or a selfie. It becomes a new character drawn in the Videorc style. The picture is used once and not kept.',
  pictureChoose: 'Choose a picture',
  pictureRemove: 'Remove',
  pictureTypeError: 'Use a PNG, JPEG or WebP picture.',
  pictureUnreadable: 'That picture could not be read. Try another one.',
  nextHint: 'Describe it or add a picture to continue.'
} as const

export const BUDDY_ONBOARDING_STEP3 = {
  nameLabel: 'Name',
  namePlaceholder: 'Buddy',
  nameHelp: '1 to 24 characters.',
  personalityLabel: 'Personality',
  personalityPlaceholder: 'Grumpy but kind. Calls viewers pebbles.',
  personalityExamples: ['Cheerful and loud', 'Dry and sarcastic', 'Calm and wise'],
  aboutLabel: 'About you (optional)',
  aboutPlaceholder:
    'I stream indie games on Tuesdays and Fridays at 8 pm. My shop is at example.com/shop.',
  aboutHelp: "Your Buddy answers viewers' questions from this."
} as const

export const BUDDY_ONBOARDING_STEP4 = {
  summaryLook: 'Look',
  summaryName: 'Name',
  summaryPersonality: 'Personality',
  summaryAbout: 'About you',
  notSet: 'Not set',
  primary: 'Create my Buddy',
  working: 'Drawing your Buddy. This takes one to three minutes.',
  poseLabels: { idle: 'Idle', talk: 'Talk', laugh: 'Laugh', think: 'Think' },
  done: 'Saved to your library.',
  use: 'Use as my Buddy',
  /** App only, after "Use as my Buddy" (plan 172 D12). */
  makeAlive: 'Make it Alive',
  redo: 'Redo',
  poseFailed: 'This pose did not come out. Redo it.'
} as const

/** Step 4 and the library: why creating is not possible now, and its actions. */
export const BUDDY_ONBOARDING_GATES = {
  signedOut: 'Sign in to create your Buddy.',
  signIn: 'Sign in',
  free: 'Creating your own Buddy is part of Videorc Premium.',
  seePremium: 'See Premium',
  startFromOurs: 'Start from one of ours',
  allowanceUsed: "You've used today's images. You get more tomorrow.",
  failed: 'Your Buddy could not be drawn. Nothing was used from your allowance. Try again.',
  cloudAiOff: 'Allow cloud AI to create a Buddy.'
} as const

export const BUDDY_LIBRARY_COPY = {
  title: 'My Buddies',
  official: 'Official',
  mine: 'Made by you',
  active: 'Active',
  use: 'Use',
  rename: 'Rename',
  editPersonality: 'Edit personality',
  delete: 'Delete',
  makeAlive: 'Make it Alive',
  newBuddy: 'New Buddy',
  emptyMine: 'Buddies you create show up here, on videorc.com and in the app.',
  deleteBody: 'Its pictures are removed from your Videorc account.',
  cancel: 'Cancel',
  signedOut: 'Sign in to see the Buddies you made on videorc.com.',
  invitation: 'Make this Buddy your own, or pick another.',
  invitationAction: 'Start',
  /** Plan 172 D12: the tag on a card whose Buddy moves. */
  alive: 'Alive',
  /** Plan 172 D10: a Buddy made only on this computer joins the library. */
  saveToLibrary: 'Save to my library'
} as const

// --- Filled-in strings --------------------------------------------------------

/** "Step 2 of 4". */
export function buddyOnboardingProgress(step: number): string {
  return `Step ${step} of ${BUDDY_ONBOARDING_STEP_COUNT}`
}

/** "Uses 4 of your 20 images left today." */
export function buddyOnboardingAllowance(remaining: number): string {
  return `Uses 4 of your ${remaining} images left today.`
}

/** "Your library is full (30 Buddies). Delete one to make room." */
export function buddyLibraryFullLine(limit: number): string {
  return `Your library is full (${limit} Buddies). Delete one to make room.`
}

/** "Delete Grum?" */
export function buddyLibraryDeleteTitle(name: string): string {
  return `Delete ${name}?`
}

/** "Grum was picked on videorc.com." */
export function buddyLibraryPickedElsewhere(name: string): string {
  return `${name} was picked on videorc.com.`
}

/** "Mossback is only on this computer." (plan 172 D10) */
export function buddyLibraryLocalOnly(name: string): string {
  return `${name} is only on this computer.`
}

/** "Downloading Golmar's moves." (plan 172 D4, D10) */
export function buddyLibraryAliveDownloading(name: string): string {
  return `Downloading ${name}'s moves.`
}

/** "Saving Grum's moves to your library." (plan 172 D10) */
export function buddyLibraryAliveUploading(name: string): string {
  return `Saving ${name}'s moves to your library.`
}

/** "Saving Mossback to your library." (plan 172 D10) */
export function buddyLibraryImporting(name: string): string {
  return `Saving ${name} to your library.`
}

/** "12/600": a field's counter. */
export function buddyOnboardingCounter(count: number, max: number): string {
  return `${count}/${max}`
}
