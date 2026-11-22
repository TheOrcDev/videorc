// Whether the streamer has pressed anything in this run of the window: a
// click or a key here (the browser's sticky user activation), a global
// shortcut, or a phone remote or Stream Deck press. At launch the
// notification center pops up nothing until they have: a toast is the answer
// to something the streamer just did, never what Videorc found on its own.

let pressedOutsideTheWindow = false

/** A press that reaches the Studio from outside this window (a global shortcut, a remote). */
export function notePressed(): void {
  pressedOutsideTheWindow = true
}

export function userHasPressed(): boolean {
  if (pressedOutsideTheWindow) return true
  if (typeof navigator === 'undefined') return false
  return navigator.userActivation?.hasBeenActive === true
}

/** Tests only. */
export function resetPressedForTests(): void {
  pressedOutsideTheWindow = false
}
