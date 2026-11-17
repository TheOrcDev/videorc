import type { CloudOutputHealth, CloudRoomParticipant, CloudShowSummary } from './backend'

/**
 * Plan 249 S26: a cloud room's health, layer by layer, so an operator can
 * tell a missing contribution, a program page that stopped reporting and a
 * bad egress from a healthy output.
 *
 * - `contribution`: what this computer (and each guest on stage) sends the
 *   room, from the room's own listing.
 * - `page`: each program page, from its beacons as the web keeps them. A page
 *   that does not report is Unknown: never healthy, never silent or black.
 * - `egress`: each program output's egress, with the profile it encodes.
 *
 * The page measures the sound it plays and the picture it draws. Neither is
 * proof of the encoded stream, and no A/V skew is measured for a managed
 * output: none is shown. Pure: the renderer's Health page and the parity
 * acceptance read the same rows. Every row's status is a sentence-case word.
 */

export type ProgramHealthLayer = 'contribution' | 'page' | 'egress'
export type ProgramHealthTone = 'good' | 'warn' | 'error' | 'neutral'

export interface ProgramHealthRow {
  /** `host-microphone`, `guest:<identity>`, `page:stream-horizontal`, `egress:…`. */
  id: string
  layer: ProgramHealthLayer
  label: string
  status: string
  tone: ProgramHealthTone
  detail: string
}

/** The renderer's own room microphone (plan 249 S7b), when it knows it. */
export interface ProgramHealthMicrophone {
  state: 'off' | 'opening' | 'published' | 'lost'
  /** A level was measured here in the last half second. */
  levelFresh: boolean
}

export interface ProgramHealthInput {
  room?: { participants?: CloudRoomParticipant[] } | null
  outputHealth?: readonly CloudOutputHealth[]
  show?: Pick<CloudShowSummary, 'outputProfile'> | null
  microphone?: ProgramHealthMicrophone | null
}

/** Says what the program preview is, and what it is not. */
export const PROGRAM_PREVIEW_NOTE =
  "The program preview is drawn on this computer from the room. It isn't the encoded stream, and it never proves what viewers hear."

const OUTPUT_WORD: Record<string, string> = { stream: 'stream', recording: 'recording' }
const ORIENTATION_WORD: Record<string, string> = {
  horizontal: 'Horizontal',
  vertical: 'Vertical'
}

function seconds(value: number | undefined): string {
  return `${value ?? 0} s`
}

function outputLabel(entry: CloudOutputHealth): string | null {
  const orientation = ORIENTATION_WORD[entry.orientation]
  const output = OUTPUT_WORD[entry.output]
  return orientation && output ? `${orientation} ${output}` : null
}

function contributionRows(input: ProgramHealthInput): ProgramHealthRow[] {
  const participants = input.room?.participants ?? []
  const rows: ProgramHealthRow[] = []
  if (participants.length === 0) {
    return [
      {
        id: 'host-microphone',
        layer: 'contribution',
        label: 'Your microphone',
        status: 'Unknown',
        tone: 'neutral',
        detail: "The room hasn't listed anyone yet."
      }
    ]
  }
  const host = participants.find((person) => person.role === 'host')
  if (!host) {
    return [
      {
        id: 'host-room',
        layer: 'contribution',
        label: 'This computer',
        status: 'Not in room',
        tone: 'error',
        detail: "This computer isn't in the room. Guests and viewers see the away card."
      }
    ]
  }
  const microphone = input.microphone
  rows.push(
    !host.audio
      ? {
          id: 'host-microphone',
          layer: 'contribution',
          label: 'Your microphone',
          status: 'Missing',
          tone: 'error',
          detail:
            microphone?.state === 'lost'
              ? 'The room has no microphone from you: the device was lost.'
              : 'The room has no microphone from you.'
        }
      : host.muted
        ? {
            id: 'host-microphone',
            layer: 'contribution',
            label: 'Your microphone',
            status: 'Muted',
            tone: 'warn',
            detail: 'You muted your microphone. Viewers hear no voice from you.'
          }
        : {
            id: 'host-microphone',
            layer: 'contribution',
            label: 'Your microphone',
            status: 'Published',
            tone: 'good',
            detail: microphone?.levelFresh
              ? 'In the room. Its level is measured on this computer.'
              : "In the room. Its level isn't measured here, so silence reads as Unknown."
          }
  )
  rows.push(
    !host.video
      ? {
          id: 'host-camera',
          layer: 'contribution',
          label: 'Your camera',
          status: 'Off',
          tone: 'neutral',
          detail: 'Your camera is switched off.'
        }
      : !host.onStage
        ? {
            id: 'host-camera',
            layer: 'contribution',
            label: 'Your camera',
            status: 'Off stage',
            tone: 'neutral',
            detail: "You're off stage."
          }
        : host.away
          ? {
              id: 'host-camera',
              layer: 'contribution',
              label: 'Your camera',
              status: 'No frames',
              tone: 'warn',
              detail: 'The program draws no frame of your camera. Viewers see the away card.'
            }
          : {
              id: 'host-camera',
              layer: 'contribution',
              label: 'Your camera',
              status: 'On program',
              tone: 'good',
              detail: 'The program draws your camera.'
            }
  )
  for (const guest of participants) {
    if (guest.role === 'host' || !guest.onStage) continue
    const name = guest.name.trim() || 'Guest'
    rows.push(
      guest.video && guest.away
        ? {
            id: `guest:${guest.identity}`,
            layer: 'contribution',
            label: name,
            status: 'No frames',
            tone: 'warn',
            detail: "The program draws no frame of this guest's camera."
          }
        : !guest.audio
          ? {
              id: `guest:${guest.identity}`,
              layer: 'contribution',
              label: name,
              status: 'No microphone',
              tone: 'warn',
              detail: 'The room has no microphone from this guest.'
            }
          : {
              id: `guest:${guest.identity}`,
              layer: 'contribution',
              label: name,
              status: 'On stage',
              tone: 'good',
              detail: guest.video ? 'On the program.' : 'On the program, camera off.'
            }
    )
  }
  return rows
}

function faultWords(entry: CloudOutputHealth): string | null {
  const asset = entry.faults?.asset ?? 0
  const drop = entry.faults?.drop ?? 0
  const parts: string[] = []
  if (asset > 0) parts.push(`${asset} ${asset === 1 ? 'layer' : 'layers'} failed to draw`)
  if (drop > 0) parts.push(`${drop} dropped at a limit`)
  return parts.length ? `${parts.join(', ')} since the page started.` : null
}

function pageRow(entry: CloudOutputHealth, label: string): ProgramHealthRow {
  const id = `page:${entry.output}-${entry.orientation}`
  const base = { id, layer: 'page' as const, label: `${label} page` }
  const faults = faultWords(entry)
  if (entry.page === 'stale') {
    return {
      ...base,
      status: 'Not reporting',
      tone: 'error',
      detail: `Its last report was ${seconds(entry.pageAgeSeconds)} ago. What its viewers see and hear is unknown.`
    }
  }
  if (entry.page === 'missing') {
    return entry.egress === 'active'
      ? {
          ...base,
          status: 'Not reporting',
          tone: 'error',
          detail: "It hasn't reported yet. What its viewers see and hear is unknown."
        }
      : { ...base, status: 'Waiting', tone: 'neutral', detail: 'Its page is starting.' }
  }
  if (entry.page !== 'reporting') {
    return { ...base, status: 'Unknown', tone: 'neutral', detail: "This app can't read its state." }
  }
  const program = entry.program ?? {}
  const problems: string[] = []
  if ((program.blackSeconds ?? 0) > 0) problems.push(`black for ${seconds(program.blackSeconds)}`)
  if ((program.frozenSeconds ?? 0) > 0)
    problems.push(`frozen for ${seconds(program.frozenSeconds)}`)
  if (entry.audio === 'measured' && (program.audioSilentSeconds ?? 0) > 0)
    problems.push(`silent for ${seconds(program.audioSilentSeconds)}`)
  const sound =
    entry.audio === 'measured'
      ? 'It measures the sound it plays, not the encoded stream.'
      : 'It has no sound meter: what its viewers hear is unknown.'
  const tail = [sound, faults].filter(Boolean).join(' ')
  if (problems.length) {
    const sentence = problems.join(', ')
    return {
      ...base,
      status:
        (program.blackSeconds ?? 0) > 0
          ? 'Black'
          : (program.frozenSeconds ?? 0) > 0
            ? 'Frozen'
            : 'Silent',
      tone: 'error',
      detail: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. ${tail}`
    }
  }
  return {
    ...base,
    status: 'Reporting',
    tone: entry.audio === 'measured' && !faults ? 'good' : 'warn',
    detail: `Reported ${seconds(entry.pageAgeSeconds)} ago${entry.stageKey ? ', stage applied' : ''}. ${tail}`
  }
}

function egressRow(
  entry: CloudOutputHealth,
  label: string,
  show: ProgramHealthInput['show']
): ProgramHealthRow {
  const base = {
    id: `egress:${entry.output}-${entry.orientation}`,
    layer: 'egress' as const,
    label: `${label} output`
  }
  const takes = entry.alsoRecords ? ' It also records the take.' : ''
  switch (entry.egress) {
    case 'active': {
      const profile = show?.outputProfile?.effective.find(
        (output) => output.orientation === entry.orientation
      )
      return {
        ...base,
        status: 'Running',
        tone: 'good',
        detail: profile
          ? `${profile.width}×${profile.height}, ${profile.pictureFps} fps picture, ${profile.videoKbps / 1000} Mbps.${takes}`
          : `Running. Its profile wasn't reported.${takes}`
      }
    }
    case 'starting':
      return { ...base, status: 'Starting', tone: 'neutral', detail: 'The cloud is starting it.' }
    case 'ending':
    case 'complete':
      return { ...base, status: 'Ended', tone: 'neutral', detail: 'This output has ended.' }
    case 'failed':
    case 'aborted':
    case 'limit-reached':
      return {
        ...base,
        status: 'Failed',
        tone: 'error',
        detail: 'The cloud stopped this output.'
      }
    default:
      return {
        ...base,
        status: 'Unknown',
        tone: 'neutral',
        detail: "This app can't read its state."
      }
  }
}

/** Every row, contributions first, then each output's page and egress. */
export function programHealthRows(input: ProgramHealthInput): ProgramHealthRow[] {
  const rows = contributionRows(input)
  for (const entry of (input.outputHealth ?? []).slice(0, 4)) {
    const label = outputLabel(entry)
    if (!label) continue
    rows.push(pageRow(entry, label), egressRow(entry, label, input.show))
  }
  return rows
}

/** The worst tone among the rows: the section's one verdict. */
export function programHealthVerdict(rows: readonly ProgramHealthRow[]): ProgramHealthTone {
  if (rows.some((row) => row.tone === 'error')) return 'error'
  if (rows.some((row) => row.tone === 'warn')) return 'warn'
  if (rows.some((row) => row.tone === 'good')) return 'good'
  return 'neutral'
}
