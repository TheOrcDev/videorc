// The default avatar's name (plan 239 D2): the official stone golem's, which
// a fresh install and "Start over" wear, and the name any surface falls back
// to when a persona has none. Sidekick is the helper's name now, so the
// golem has its own. Equal to the backend's `COHOST_DEFAULT_PERSONA_NAME`
// and the golem's entry in `protocol-fixtures/buddy-official-catalog.json`.
//
// Its own module, with nothing else in it: eager copy helpers (the Stream
// Manager's labels) import it, and the official catalog must stay lazy.
export const DEFAULT_AVATAR_NAME = 'Flint'
