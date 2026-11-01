import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadPhrases } from './speech.mjs'

// The voice command parsers are Rust (cohost_command.rs, clip_marks.rs) and
// cannot be imported from Node. So each lab phrase must appear verbatim in
// the parser's own test table, with the same expected parse. If someone
// changes the grammar or its tests, this fails and the lab phrase list gets
// updated with it.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PARSERS = {
  cohost_command: 'crates/videorc-backend/src/cohost_command.rs',
  clip_marks: 'crates/videorc-backend/src/clip_marks.rs'
}

function testsModule(relativePath) {
  const source = readFileSync(join(repoRoot, relativePath), 'utf8')
  const start = source.indexOf('mod tests {')
  assert.notEqual(start, -1, `${relativePath} has a tests module`)
  return source.slice(start)
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const KINDS = {
  highlight: 'Highlight',
  clear: 'Clear',
  remove: 'Remove',
  confirm: 'Confirm',
  cancel: 'Cancel'
}
const TARGETS = { last: 'Last', deixis: 'Deixis', none: 'NoTarget' }
const CONTEXTS = { plain: 'PLAIN', answering: 'ANSWERING' }

const phrases = await loadPhrases()

test('phrases.json is well formed with unique ids', () => {
  const ids = [...phrases.commands, ...phrases.captions].map((phrase) => phrase.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const phrase of [...phrases.commands, ...phrases.captions]) {
    assert.match(phrase.id, /^[a-z0-9-]+$/)
    assert.ok(phrase.text.trim().length > 0)
  }
  assert.ok(phrases.commands.length >= 6)
  assert.ok(phrases.captions.length >= 3)
})

for (const command of phrases.commands) {
  test(`command phrase "${command.id}" parses as expected in ${command.parser}'s tests`, () => {
    const source = testsModule(PARSERS[command.parser])
    const text = escapeRegExp(command.text)
    if (command.parser === 'cohost_command') {
      const { kind, target, question } = command.expect
      assert.ok(KINDS[kind] && TARGETS[target] && CONTEXTS[command.context], command.id)
      const row = new RegExp(
        `"${text}",\\s*&${CONTEXTS[command.context]},\\s*hit\\(${KINDS[kind]},\\s*${TARGETS[target]},\\s*${question},`
      )
      assert.match(source, row, `${command.text} with ${kind}/${target} in the phrase table`)
    } else {
      // Plan 199: each row also names the clip length the phrase saves; a
      // lab phrase without `seconds` is a 30-second clip.
      const seconds = command.expect.seconds ?? 30
      const row = new RegExp(
        `\\("${text}",\\s*Some\\(\\("${escapeRegExp(command.expect.phrase)}",\\s*${seconds}\\)\\)\\)`
      )
      assert.match(source, row, `${command.text} -> ${command.expect.phrase} (${seconds} s)`)
    }
  })
}

test('only Remove phrases are marked destructive, and all of them are', () => {
  for (const command of phrases.commands) {
    assert.equal(command.destructive === true, command.expect.kind === 'remove', command.id)
  }
})

test('caption phrases carry no wake word or command words', () => {
  const trigger =
    /\b(?:buddy|orcle|orkle|orcel|oracle|clip|highlight|show|remove|delete|clear|pin|dismiss|hide|cancel|yes|no)\b/i
  for (const caption of phrases.captions) {
    assert.doesNotMatch(caption.text, trigger, caption.id)
  }
})
