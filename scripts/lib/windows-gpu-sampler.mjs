const RELEVANT_ENGINE_TYPES = new Set(['3d', 'copy', 'videoencode', 'videodecode'])
const VALID_PDH_COUNTER_STATUSES = new Set([0, 1])
const BYTES_PER_MIB = 1024 * 1024
const SAMPLE_INTERVAL_TOLERANCE_RATIO = 0.5
const SAMPLE_SPAN_TOLERANCE_RATIO = 0.02

export function normalizeWindowsGpuCounterBatch(batch) {
  if (!Array.isArray(batch?.counters)) {
    return {
      timestamp: batch?.timestamp,
      processIdentityBracket: normalizeWindowsProcessIdentityBracket(batch?.processIdentityBracket),
      engineCounters: null,
      memoryCounters: null
    }
  }
  const engineCounters = []
  const memoryByInstance = new Map()
  for (const counter of batch.counters) {
    const path = String(counter?.path ?? '')
    const instanceName = String(counter?.instanceName ?? '')
    if (/\\gpu engine\(/i.test(path) && /utilization percentage/i.test(path)) {
      engineCounters.push({
        instanceName,
        value: normalizeFiniteCounterValue(counter.value),
        status: normalizePdhCounterStatus(counter.status)
      })
      continue
    }
    const memory = memoryByInstance.get(instanceName) ?? {
      instanceName,
      dedicatedBytes: Number.NaN,
      dedicatedStatus: Number.NaN,
      sharedBytes: Number.NaN,
      sharedStatus: Number.NaN
    }
    if (/\\gpu process memory\(/i.test(path) && /dedicated usage/i.test(path)) {
      memory.dedicatedBytes = normalizeFiniteCounterValue(counter.value)
      memory.dedicatedStatus = normalizePdhCounterStatus(counter.status)
      memoryByInstance.set(instanceName, memory)
    } else if (/\\gpu process memory\(/i.test(path) && /shared usage/i.test(path)) {
      memory.sharedBytes = normalizeFiniteCounterValue(counter.value)
      memory.sharedStatus = normalizePdhCounterStatus(counter.status)
      memoryByInstance.set(instanceName, memory)
    }
  }
  return {
    timestamp: batch.timestamp,
    processIdentityBracket: normalizeWindowsProcessIdentityBracket(batch.processIdentityBracket),
    engineCounters,
    memoryCounters: [...memoryByInstance.values()]
  }
}

export function normalizeWindowsProcessIdentityBracket(bracket) {
  if (!bracket || typeof bracket !== 'object') return null
  return {
    before: normalizeWindowsProcessSnapshot(bracket.before),
    after: normalizeWindowsProcessSnapshot(bracket.after)
  }
}

export function normalizeWindowsProcessSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  return {
    sampledAt: snapshot.sampledAt,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    processes: Array.isArray(snapshot.processes)
      ? snapshot.processes.map((process) => ({
          pid: Number(process?.pid),
          parentPid: Number(process?.parentPid),
          creationDate:
            typeof process?.creationDate === 'string' ? process.creationDate : process?.creationDate
        }))
      : null
  }
}

export function parseWindowsGpuCounterInstance(instanceName) {
  if (typeof instanceName !== 'string' || !instanceName.trim()) return null
  const pid = /(?:^|_)pid_(\d+)(?:_|$)/i.exec(instanceName)
  const luid = /(?:^|_)luid_(0x[0-9a-f]+)_(0x[0-9a-f]+)(?:_|$)/i.exec(instanceName)
  const engineType = /(?:^|_)engtype_([^_\\]+)/i.exec(instanceName)
  if (!pid || !luid) return null
  return {
    pid: Number(pid[1]),
    adapterLuid: normalizeAdapterLuid(`${luid[1]}:${luid[2]}`),
    engineType: engineType?.[1]?.replaceAll(' ', '').toLocaleLowerCase('en-US')
  }
}

export function attributeWindowsGpuSamplesToProcessTimeline({
  samples,
  candidateRootPid,
  candidateRootCreationDate,
  expectedSamples,
  intervalMs,
  timeline,
  parseInstance = parseWindowsGpuCounterInstance,
  maximumSampleDistanceMs
}) {
  const blockers = []
  const expectedTimelineSamples = Number(expectedSamples ?? timeline?.expectedSamples)
  const sampleIntervalMs = Number(intervalMs ?? timeline?.intervalMs)
  const maximumDistance = Number.isFinite(maximumSampleDistanceMs)
    ? maximumSampleDistanceMs
    : sampleIntervalMs * 1.5
  const rootPid = Number(candidateRootPid ?? timeline?.rootPid)
  if (!Number.isInteger(expectedTimelineSamples) || expectedTimelineSamples <= 0) {
    blockers.push('expected timestamp-coherent GPU/process sample count was invalid')
  }
  if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs <= 0) {
    blockers.push('timestamp-coherent GPU/process sample interval was invalid')
  }
  if (!Number.isFinite(maximumDistance) || maximumDistance <= 0) {
    blockers.push('GPU/process snapshot attribution distance was invalid')
  }
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    blockers.push('candidate root PID was missing or invalid')
  }
  if (typeof parseInstance !== 'function') {
    throw new TypeError('GPU process attribution requires an instance parser.')
  }

  const requestedRootCreationDate =
    candidateRootCreationDate === undefined
      ? null
      : normalizeProcessCreationDate(candidateRootCreationDate)
  if (candidateRootCreationDate !== undefined && requestedRootCreationDate === null) {
    blockers.push('candidate root CreationDate/start identity was invalid')
  }
  let pinnedRootCreationDate = requestedRootCreationDate
  let rootIdentitySource = requestedRootCreationDate ? 'candidate' : null
  let completeBrackets = 0
  const processIds = new Set()
  const ownedIdentities = new Set()
  const ownedCreationDatesByPid = new Map()
  const attributedSamples = []
  const rawSamples = Array.isArray(samples) ? samples : []
  const cadence = validateWindowsGpuSampleCadence({
    samples: rawSamples,
    expectedSamples: expectedTimelineSamples,
    intervalMs: sampleIntervalMs
  })
  blockers.push(...cadence.blockers)
  const orderedSamples = rawSamples
    .map((sample, index) => ({
      sample,
      index,
      sampledAtMs: timestampMilliseconds(sample?.timestamp)
    }))
    .sort((left, right) => {
      const leftTimestampValid = Number.isFinite(left.sampledAtMs)
      const rightTimestampValid = Number.isFinite(right.sampledAtMs)
      if (!leftTimestampValid && !rightTimestampValid) return left.index - right.index
      if (!leftTimestampValid) return 1
      if (!rightTimestampValid) return -1
      return left.sampledAtMs - right.sampledAtMs || left.index - right.index
    })

  for (const { sample, index, sampledAtMs } of orderedSamples) {
    const sampleNumber = index + 1
    const bracketResult = validateWindowsProcessIdentityBracket({
      bracket: sample?.processIdentityBracket,
      sampledAtMs,
      maximumDistance,
      sampleNumber
    })
    blockers.push(...bracketResult.blockers)
    if (bracketResult.complete) completeBrackets += 1

    const beforeProcesses = bracketResult.before.processesByPid
    const afterProcesses = bracketResult.after.processesByPid
    const beforeRoot = beforeProcesses.get(rootPid)
    const afterRoot = afterProcesses.get(rootPid)
    const bracketRootCreationDate =
      beforeRoot && afterRoot && beforeRoot.creationDate === afterRoot.creationDate
        ? beforeRoot.creationDate
        : null
    if (bracketRootCreationDate && pinnedRootCreationDate === null) {
      pinnedRootCreationDate = bracketRootCreationDate
      rootIdentitySource = 'first-process-identity-bracket'
    }

    const rootIdentityMatches = Boolean(
      beforeRoot &&
      afterRoot &&
      beforeRoot.creationDate === afterRoot.creationDate &&
      pinnedRootCreationDate !== null &&
      beforeRoot.creationDate === pinnedRootCreationDate
    )
    if (!beforeRoot || !afterRoot) {
      blockers.push(
        `GPU sample ${sampleNumber} identity bracket omitted candidate root PID ${rootPid} before or after the counter sample`
      )
    } else if (beforeRoot.creationDate !== afterRoot.creationDate) {
      blockers.push(
        `GPU sample ${sampleNumber} candidate root PID ${rootPid} was reused inside the counter bracket: ${beforeRoot.creationDate} -> ${afterRoot.creationDate}`
      )
    } else if (
      pinnedRootCreationDate !== null &&
      beforeRoot.creationDate !== pinnedRootCreationDate
    ) {
      blockers.push(
        `GPU sample ${sampleNumber} candidate root PID ${rootPid} was reused: expected CreationDate ${pinnedRootCreationDate}, observed ${beforeRoot.creationDate}`
      )
    }

    const beforeOwned = rootIdentityMatches
      ? deriveOwnedProcessIdentities({
          processesByPid: beforeProcesses,
          rootPid,
          rootCreationDate: pinnedRootCreationDate,
          knownOwnedIdentities: ownedIdentities
        })
      : emptyProcessIdentitySet()
    const afterOwned = rootIdentityMatches
      ? deriveOwnedProcessIdentities({
          processesByPid: afterProcesses,
          rootPid,
          rootCreationDate: pinnedRootCreationDate,
          knownOwnedIdentities: new Set([...ownedIdentities, ...beforeOwned.identities])
        })
      : emptyProcessIdentitySet()
    const beforeSystemPids = deriveKnownUnrelatedProcessIds({
      processesByPid: beforeProcesses,
      ownedPids: beforeOwned.pids,
      rootCreatedAtMs: beforeRoot?.createdAtMs
    })
    const afterSystemPids = deriveKnownUnrelatedProcessIds({
      processesByPid: afterProcesses,
      ownedPids: afterOwned.pids,
      rootCreatedAtMs: afterRoot?.createdAtMs
    })

    const stableProcessesByPid = new Map()
    const bracketReusedPids = new Set()
    for (const pid of new Set([...beforeProcesses.keys(), ...afterProcesses.keys()])) {
      const before = beforeProcesses.get(pid)
      const after = afterProcesses.get(pid)
      if (!before || !after) continue
      if (before.creationDate !== after.creationDate) {
        bracketReusedPids.add(pid)
        continue
      }
      stableProcessesByPid.set(pid, after)
    }

    const reusedPreviouslyOwnedPids = new Set()
    for (const process of stableProcessesByPid.values()) {
      const previousCreationDates = ownedCreationDatesByPid.get(process.pid)
      if (previousCreationDates && !previousCreationDates.has(process.creationDate)) {
        reusedPreviouslyOwnedPids.add(process.pid)
        blockers.push(
          `GPU sample ${sampleNumber} observed PID reuse for previously app-owned PID ${process.pid}: ${[...previousCreationDates].at(-1)} -> ${process.creationDate}`
        )
      }
    }

    const ownedEngineCounters = []
    const ownedMemoryCounters = []
    const systemEngineCounters = []
    const systemMemoryCounters = []
    const unknownEngineCounters = []
    const unknownMemoryCounters = []
    const systemGpuPids = new Set()
    const unknownGpuPids = new Set()
    const classifyCounter = (counter, owned, system, unknown, counterKind) => {
      const parsed = parseInstance(counter?.instanceName)
      blockers.push(
        ...pdhCounterStatusBlockers({
          counter,
          counterKind,
          sampleNumber,
          pid: parsed?.pid
        })
      )
      if (!parsed) {
        unknown.push(counter)
        blockers.push(
          `GPU sample ${sampleNumber} ${counterKind} counter instance could not be bound to a PID`
        )
        return
      }
      const stableProcess = stableProcessesByPid.get(parsed.pid)
      const ownedAtCounter =
        stableProcess &&
        beforeOwned.pids.has(parsed.pid) &&
        afterOwned.pids.has(parsed.pid) &&
        !reusedPreviouslyOwnedPids.has(parsed.pid)
      const knownSystemAtCounter =
        stableProcess &&
        beforeSystemPids.has(parsed.pid) &&
        afterSystemPids.has(parsed.pid) &&
        !ownedCreationDatesByPid.has(parsed.pid)
      if (ownedAtCounter) {
        owned.push(counter)
        return
      }
      if (knownSystemAtCounter) {
        system.push(counter)
        systemGpuPids.add(parsed.pid)
        return
      }
      unknown.push(counter)
      unknownGpuPids.add(parsed.pid)
      if (bracketReusedPids.has(parsed.pid)) {
        blockers.push(
          `GPU sample ${sampleNumber} PID ${parsed.pid} changed CreationDate inside its process identity bracket`
        )
      } else if (!beforeProcesses.has(parsed.pid) || !afterProcesses.has(parsed.pid)) {
        blockers.push(
          `GPU sample ${sampleNumber} contained GPU counters for PID ${parsed.pid}, whose identity did not span both sides of the counter bracket`
        )
      } else {
        blockers.push(
          `GPU sample ${sampleNumber} could not prove app or unrelated-system ownership for GPU PID ${parsed.pid} at the counter timestamp`
        )
      }
    }
    const sampleEngineCounters = Array.isArray(sample?.engineCounters) ? sample.engineCounters : []
    const sampleMemoryCounters = Array.isArray(sample?.memoryCounters) ? sample.memoryCounters : []
    if (!Array.isArray(sample?.engineCounters) || !Array.isArray(sample?.memoryCounters)) {
      blockers.push(`GPU sample ${sampleNumber} was missing engine or process-memory counters`)
    }
    for (const counter of sampleEngineCounters) {
      classifyCounter(
        counter,
        ownedEngineCounters,
        systemEngineCounters,
        unknownEngineCounters,
        'engine'
      )
    }
    for (const counter of sampleMemoryCounters) {
      classifyCounter(
        counter,
        ownedMemoryCounters,
        systemMemoryCounters,
        unknownMemoryCounters,
        'process-memory'
      )
    }

    const stableOwnedProcesses = [...stableProcessesByPid.values()].filter(
      (process) =>
        beforeOwned.pids.has(process.pid) &&
        afterOwned.pids.has(process.pid) &&
        !reusedPreviouslyOwnedPids.has(process.pid)
    )
    for (const process of stableOwnedProcesses) {
      processIds.add(process.pid)
      ownedIdentities.add(processIdentity(process))
      const creationDates = ownedCreationDatesByPid.get(process.pid) ?? new Set()
      creationDates.add(process.creationDate)
      ownedCreationDatesByPid.set(process.pid, creationDates)
    }

    attributedSamples[index] = {
      timestamp: sample?.timestamp,
      processIdentityBracket: sample?.processIdentityBracket ?? null,
      engineCounters: ownedEngineCounters,
      memoryCounters: ownedMemoryCounters,
      systemEngineCounters,
      systemMemoryCounters,
      unknownEngineCounters,
      unknownMemoryCounters,
      processOwnership: {
        rootPid,
        rootCreationDate: pinnedRootCreationDate,
        ownedProcesses: stableOwnedProcesses
          .map(({ pid, parentPid, creationDate }) => ({ pid, parentPid, creationDate }))
          .sort((left, right) => left.pid - right.pid),
        systemGpuPids: [...systemGpuPids].sort((left, right) => left - right),
        unknownGpuPids: [...unknownGpuPids].sort((left, right) => left - right)
      }
    }
  }
  if (!Array.isArray(samples)) blockers.push('GPU samples were missing')
  if (
    Number.isInteger(expectedTimelineSamples) &&
    expectedTimelineSamples > 0 &&
    completeBrackets / expectedTimelineSamples < 0.9
  ) {
    blockers.push(
      `timestamp-coherent GPU/process identity-bracket coverage ${completeBrackets}/${expectedTimelineSamples} was below the required 90%`
    )
  }
  if (completeBrackets === 0) {
    blockers.push('GPU samples contained no complete timestamp-coherent process identity brackets')
  }

  return {
    verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    blockers: [...new Set(blockers)],
    rootProcess:
      Number.isInteger(rootPid) && pinnedRootCreationDate
        ? {
            pid: rootPid,
            creationDate: pinnedRootCreationDate,
            identitySource: rootIdentitySource
          }
        : null,
    processIds: [...processIds].sort((left, right) => left - right),
    samples: attributedSamples,
    timeline: {
      expectedSamples: expectedTimelineSamples,
      completeSamples: completeBrackets,
      coverageRatio:
        Number.isInteger(expectedTimelineSamples) && expectedTimelineSamples > 0
          ? completeBrackets / expectedTimelineSamples
          : null,
      cadence: cadence.summary
    }
  }
}

export function summarizeWindowsGpuSamples({ samples, expectedSamples, processIds, adapterLuid }) {
  const blockers = []
  const normalizedAdapter = normalizeAdapterLuid(adapterLuid)
  const attributedPids = new Set(
    Array.from(processIds ?? [], Number).filter((pid) => Number.isInteger(pid) && pid > 0)
  )
  if (!normalizedAdapter) blockers.push('selected adapter LUID was missing or invalid')
  if (!Number.isInteger(expectedSamples) || expectedSamples <= 0) {
    blockers.push('expected GPU sample count was invalid')
  }
  if (!Array.isArray(samples)) {
    return {
      verdict: 'BLOCKED',
      blockers: [...blockers, 'GPU samples were missing'],
      summary: null
    }
  }

  const complete = []
  const unattributedPids = new Set()
  const differentAdapters = new Set()
  for (const [index, sample] of samples.entries()) {
    const engineCounters = Array.isArray(sample?.engineCounters) ? sample.engineCounters : null
    const memoryCounters = Array.isArray(sample?.memoryCounters) ? sample.memoryCounters : null
    if (!engineCounters || !memoryCounters) {
      blockers.push(`GPU sample ${index + 1} was missing engine or process-memory counters`)
      continue
    }

    let invalid = false
    const engineValues = []
    const memoryByPid = new Map()
    const inspectInstance = (counter) => {
      const parsed = parseWindowsGpuCounterInstance(counter?.instanceName)
      if (!parsed) {
        invalid = true
        return null
      }
      if (!attributedPids.has(parsed.pid)) {
        unattributedPids.add(parsed.pid)
        return null
      }
      if (normalizedAdapter && parsed.adapterLuid !== normalizedAdapter) {
        differentAdapters.add(parsed.adapterLuid)
        return null
      }
      return parsed
    }

    for (const counter of engineCounters) {
      const parsed = inspectInstance(counter)
      if (!parsed) continue
      const value = normalizeFiniteCounterValue(counter.value)
      if (
        !pdhCounterStatusIsValid(counter.status) ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 100
      ) {
        invalid = true
        continue
      }
      if (parsed.engineType && RELEVANT_ENGINE_TYPES.has(parsed.engineType)) {
        engineValues.push(value)
      }
    }
    for (const counter of memoryCounters) {
      const parsed = inspectInstance(counter)
      if (!parsed) continue
      const dedicatedBytes = normalizeFiniteCounterValue(counter.dedicatedBytes)
      const sharedBytes = normalizeFiniteCounterValue(counter.sharedBytes)
      if (
        !pdhCounterStatusIsValid(counter.dedicatedStatus) ||
        !pdhCounterStatusIsValid(counter.sharedStatus) ||
        !Number.isFinite(dedicatedBytes) ||
        dedicatedBytes < 0 ||
        !Number.isFinite(sharedBytes) ||
        sharedBytes < 0
      ) {
        invalid = true
        continue
      }
      const current = memoryByPid.get(parsed.pid)
      // Windows can expose more than one physical-adapter instance for a PID.
      // The selected adapter is already filtered; retain the largest value for
      // duplicate instances rather than summing aliases.
      memoryByPid.set(parsed.pid, {
        dedicatedBytes: Math.max(current?.dedicatedBytes ?? 0, dedicatedBytes),
        sharedBytes: Math.max(current?.sharedBytes ?? 0, sharedBytes)
      })
    }
    if (invalid || engineValues.length === 0 || memoryByPid.size === 0) {
      blockers.push(`GPU sample ${index + 1} contained incomplete or non-finite counters`)
      continue
    }
    complete.push({
      timestamp: sample.timestamp,
      // Engines operate concurrently, so busy is the maximum relevant engine
      // utilization for the sample. Summing 3D/copy/encode/decode can exceed
      // 100% and would not represent GPU saturation.
      engineBusyPercent: Math.max(...engineValues),
      dedicatedMiB:
        [...memoryByPid.values()].reduce((sum, item) => sum + item.dedicatedBytes, 0) /
        BYTES_PER_MIB,
      sharedMiB:
        [...memoryByPid.values()].reduce((sum, item) => sum + item.sharedBytes, 0) / BYTES_PER_MIB
    })
  }

  if (unattributedPids.size > 0) {
    blockers.push(
      `GPU counters contained PIDs outside the attributed app process tree: ${[...unattributedPids].sort((a, b) => a - b).join(', ')}`
    )
  }
  if (differentAdapters.size > 0) {
    blockers.push(
      `GPU counters came from a different adapter: ${[...differentAdapters].sort().join(', ')}`
    )
  }
  if (
    Number.isInteger(expectedSamples) &&
    expectedSamples > 0 &&
    complete.length / expectedSamples < 0.9
  ) {
    blockers.push(
      `GPU sample coverage ${complete.length}/${expectedSamples} was below the required 90%`
    )
  }

  const summary =
    complete.length === 0
      ? null
      : {
          expectedSamples,
          completeSamples: complete.length,
          coverageRatio:
            Number.isInteger(expectedSamples) && expectedSamples > 0
              ? complete.length / expectedSamples
              : null,
          engineBusyP95Percent: percentile(
            complete.map((sample) => sample.engineBusyPercent),
            0.95
          ),
          dedicatedP95MiB: percentile(
            complete.map((sample) => sample.dedicatedMiB),
            0.95
          ),
          dedicatedMaxMiB: Math.max(...complete.map((sample) => sample.dedicatedMiB)),
          sharedP95MiB: percentile(
            complete.map((sample) => sample.sharedMiB),
            0.95
          ),
          sharedMaxMiB: Math.max(...complete.map((sample) => sample.sharedMiB))
        }

  return {
    verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    blockers,
    summary
  }
}

export function windowsGpuCounterPowerShellScript({ intervalSeconds = 1, maxSamples }) {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error('GPU sample interval must be positive.')
  }
  if (!Number.isInteger(maxSamples) || maxSamples <= 0) {
    throw new Error('GPU maxSamples must be a positive integer.')
  }
  return String.raw`
$ErrorActionPreference = 'Stop'
$paths = @(
  '\GPU Engine(*)\Utilization Percentage',
  '\GPU Process Memory(*)\Dedicated Usage',
  '\GPU Process Memory(*)\Shared Usage'
)
$getProcessIdentitySnapshot = {
  $snapshotStartedAt = [DateTime]::UtcNow
  $processRows = @(
    Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate |
      Sort-Object -Property ProcessId |
      ForEach-Object {
        $creationDate = if ($null -eq $_.CreationDate) {
          $null
        } else {
          ([DateTime]$_.CreationDate).ToUniversalTime().ToString('o')
        }
        [ordered]@{
          pid = [int64]$_.ProcessId
          parentPid = [int64]$_.ParentProcessId
          creationDate = $creationDate
        }
      }
  )
  $snapshotCompletedAt = [DateTime]::UtcNow
  [ordered]@{
    sampledAt = $snapshotCompletedAt.ToString('o')
    startedAt = $snapshotStartedAt.ToString('o')
    completedAt = $snapshotCompletedAt.ToString('o')
    processes = @($processRows)
  }
}
$beforeCounterSnapshot = & $getProcessIdentitySnapshot
Get-Counter -Counter $paths -SampleInterval ${intervalSeconds} -MaxSamples ${maxSamples} |
  ForEach-Object {
    $counterSet = $_
    $afterCounterSnapshot = & $getProcessIdentitySnapshot
    $rows = $counterSet.CounterSamples | ForEach-Object {
      [ordered]@{
        path = $_.Path
        instanceName = $_.InstanceName
        value = [double]$_.CookedValue
        status = [int64]$_.Status
      }
    }
    [ordered]@{
      timestamp = $counterSet.Timestamp.ToUniversalTime().ToString('o')
      processIdentityBracket = [ordered]@{
        before = $beforeCounterSnapshot
        after = $afterCounterSnapshot
      }
      counters = @($rows)
    } | ConvertTo-Json -Compress -Depth 6
    $beforeCounterSnapshot = $afterCounterSnapshot
  }
`.trim()
}

function normalizeAdapterLuid(value) {
  if (typeof value !== 'string') return null
  const match = /^(0x[0-9a-f]+):(0x[0-9a-f]+)$/i.exec(value.trim())
  if (!match) return null
  return `${match[1].toLocaleLowerCase('en-US')}:${match[2].toLocaleLowerCase('en-US')}`
}

function normalizePdhCounterStatus(value) {
  const numeric = typeof value === 'number' ? value : Number.NaN
  if (!Number.isInteger(numeric) || numeric < -0x8000_0000 || numeric > 0xffff_ffff) {
    return Number.NaN
  }
  return numeric < 0 ? numeric + 0x1_0000_0000 : numeric
}

function normalizeFiniteCounterValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
}

function validateWindowsGpuSampleCadence({ samples, expectedSamples, intervalMs }) {
  if (
    !Number.isInteger(expectedSamples) ||
    expectedSamples <= 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    return { blockers: [], summary: null }
  }

  const blockers = []
  const timestamps = samples.map((sample) => timestampMilliseconds(sample?.timestamp))
  for (const [index, timestamp] of timestamps.entries()) {
    if (!Number.isFinite(timestamp)) {
      blockers.push(`GPU sample ${index + 1} timestamp was missing or invalid`)
    }
  }

  const validTimestamps = timestamps.filter(Number.isFinite)
  const minimumIntervalMs = intervalMs * (1 - SAMPLE_INTERVAL_TOLERANCE_RATIO)
  const maximumIntervalMs = intervalMs * (1 + SAMPLE_INTERVAL_TOLERANCE_RATIO)
  const observedIntervalsMs = []
  for (let index = 1; index < timestamps.length; index += 1) {
    const previous = timestamps[index - 1]
    const current = timestamps[index]
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue
    const observedIntervalMs = current - previous
    observedIntervalsMs.push(observedIntervalMs)
    if (observedIntervalMs <= 0) {
      blockers.push(
        `GPU sample ${index + 1} timestamp was not strictly monotonic (${observedIntervalMs}ms after sample ${index})`
      )
      continue
    }
    if (observedIntervalMs < minimumIntervalMs || observedIntervalMs > maximumIntervalMs) {
      blockers.push(
        `GPU sample ${index + 1} cadence interval ${observedIntervalMs}ms was outside the inclusive ${minimumIntervalMs}-${maximumIntervalMs}ms range`
      )
    }
  }

  const expectedSpanMs = Math.max(0, expectedSamples - 1) * intervalMs
  const spanToleranceMs =
    expectedSamples <= 1 ? 0 : Math.max(intervalMs, expectedSpanMs * SAMPLE_SPAN_TOLERANCE_RATIO)
  const observedSpanMs =
    validTimestamps.length > 0 ? validTimestamps.at(-1) - validTimestamps[0] : Number.NaN
  const minimumSpanMs = Math.max(0, expectedSpanMs - spanToleranceMs)
  const maximumSpanMs = expectedSpanMs + spanToleranceMs
  if (
    Number.isFinite(observedSpanMs) &&
    (observedSpanMs < minimumSpanMs || observedSpanMs > maximumSpanMs)
  ) {
    blockers.push(
      `GPU sample timestamp span ${observedSpanMs}ms was outside the inclusive ${minimumSpanMs}-${maximumSpanMs}ms range for ${expectedSamples} samples at ${intervalMs}ms`
    )
  }

  return {
    blockers,
    summary: {
      validTimestampSamples: validTimestamps.length,
      expectedSpanMs,
      observedSpanMs: Number.isFinite(observedSpanMs) ? observedSpanMs : null,
      minimumIntervalMs,
      maximumIntervalMs,
      minimumSpanMs,
      maximumSpanMs,
      minimumObservedIntervalMs:
        observedIntervalsMs.length > 0 ? Math.min(...observedIntervalsMs) : null,
      maximumObservedIntervalMs:
        observedIntervalsMs.length > 0 ? Math.max(...observedIntervalsMs) : null
    }
  }
}

function timestampMilliseconds(value) {
  if (Number.isFinite(value)) return Number(value)
  if (typeof value !== 'string') return Number.NaN
  const dotNetDate = /^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/.exec(value.trim())
  if (dotNetDate) return Number(dotNetDate[1])
  return Date.parse(value)
}

function normalizeProcessCreationDate(value) {
  const milliseconds = timestampMilliseconds(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null
}

function processIdentity(process) {
  return `${process.pid}@${process.creationDate}`
}

function emptyProcessIdentitySet() {
  return { pids: new Set(), identities: new Set() }
}

function deriveOwnedProcessIdentities({
  processesByPid,
  rootPid,
  rootCreationDate,
  knownOwnedIdentities
}) {
  const result = emptyProcessIdentitySet()
  const root = processesByPid.get(rootPid)
  if (!root || root.creationDate !== rootCreationDate) return result
  result.pids.add(rootPid)
  result.identities.add(processIdentity(root))
  for (const process of processesByPid.values()) {
    const identity = processIdentity(process)
    if (!knownOwnedIdentities.has(identity)) continue
    result.pids.add(process.pid)
    result.identities.add(identity)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const process of processesByPid.values()) {
      if (result.pids.has(process.pid)) continue
      const parent = processesByPid.get(process.parentPid)
      if (!parent || !result.pids.has(parent.pid) || process.createdAtMs < parent.createdAtMs) {
        continue
      }
      result.pids.add(process.pid)
      result.identities.add(processIdentity(process))
      changed = true
    }
  }
  return result
}

function deriveKnownUnrelatedProcessIds({ processesByPid, ownedPids, rootCreatedAtMs }) {
  const knownUnrelatedPids = new Set()
  if (!Number.isFinite(rootCreatedAtMs)) return knownUnrelatedPids
  const verdictByPid = new Map()
  const visit = (pid, visiting) => {
    if (ownedPids.has(pid)) return false
    if (verdictByPid.has(pid)) return verdictByPid.get(pid)
    if (visiting.has(pid)) return false
    const process = processesByPid.get(pid)
    if (!process) return false
    if (process.createdAtMs < rootCreatedAtMs || process.parentPid === 0) {
      verdictByPid.set(pid, true)
      return true
    }
    const parent = processesByPid.get(process.parentPid)
    if (!parent) {
      verdictByPid.set(pid, false)
      return false
    }
    if (process.createdAtMs < parent.createdAtMs) {
      verdictByPid.set(pid, true)
      return true
    }
    const nextVisiting = new Set(visiting)
    nextVisiting.add(pid)
    const unrelated = visit(parent.pid, nextVisiting)
    verdictByPid.set(pid, unrelated)
    return unrelated
  }
  for (const pid of processesByPid.keys()) {
    if (visit(pid, new Set())) knownUnrelatedPids.add(pid)
  }
  return knownUnrelatedPids
}

function pdhCounterStatusBlockers({ counter, counterKind, sampleNumber, pid }) {
  const prefix = `GPU sample ${sampleNumber} ${counterKind} counter${pid ? ` for PID ${pid}` : ''}`
  if (counterKind === 'engine') {
    return pdhCounterStatusIsValid(counter?.status)
      ? []
      : [`${prefix} had invalid PDH status ${formatPdhStatus(counter?.status)}`]
  }
  const blockers = []
  if (!pdhCounterStatusIsValid(counter?.dedicatedStatus)) {
    blockers.push(
      `${prefix} dedicated-usage value had invalid PDH status ${formatPdhStatus(counter?.dedicatedStatus)}`
    )
  }
  if (!pdhCounterStatusIsValid(counter?.sharedStatus)) {
    blockers.push(
      `${prefix} shared-usage value had invalid PDH status ${formatPdhStatus(counter?.sharedStatus)}`
    )
  }
  return blockers
}

function pdhCounterStatusIsValid(value) {
  return Number.isInteger(value) && VALID_PDH_COUNTER_STATUSES.has(value)
}

function formatPdhStatus(value) {
  return Number.isInteger(value)
    ? `0x${value.toString(16).padStart(8, '0')}`
    : 'missing/non-numeric'
}

function validateWindowsProcessIdentityBracket({
  bracket,
  sampledAtMs,
  maximumDistance,
  sampleNumber
}) {
  if (!bracket || typeof bracket !== 'object') {
    const empty = emptyValidatedProcessSnapshot()
    return {
      blockers: [
        `GPU sample ${sampleNumber} omitted its pre/post timestamp-coherent process identity bracket`
      ],
      complete: false,
      before: empty,
      after: empty
    }
  }
  const before = validateWindowsProcessSnapshot({
    snapshot: bracket.before,
    sampledAtMs,
    maximumDistance,
    sampleNumber,
    position: 'pre-counter'
  })
  const after = validateWindowsProcessSnapshot({
    snapshot: bracket.after,
    sampledAtMs,
    maximumDistance,
    sampleNumber,
    position: 'post-counter'
  })
  const blockers = [...before.blockers, ...after.blockers]
  let ordered = true
  if (
    Number.isFinite(sampledAtMs) &&
    Number.isFinite(before.completedAtMs) &&
    before.completedAtMs > sampledAtMs
  ) {
    blockers.push(
      `GPU sample ${sampleNumber} pre-counter process identity snapshot completed after the counter timestamp`
    )
    ordered = false
  }
  if (
    Number.isFinite(sampledAtMs) &&
    Number.isFinite(after.startedAtMs) &&
    after.startedAtMs < sampledAtMs
  ) {
    blockers.push(
      `GPU sample ${sampleNumber} post-counter process identity snapshot started before the counter timestamp`
    )
    ordered = false
  }
  return {
    blockers,
    complete: before.complete && after.complete && ordered,
    before,
    after
  }
}

function emptyValidatedProcessSnapshot() {
  return {
    blockers: [],
    complete: false,
    processesByPid: new Map(),
    unidentifiedProcessesByPid: new Map(),
    snapshotAtMs: Number.NaN,
    startedAtMs: Number.NaN,
    completedAtMs: Number.NaN
  }
}

function validateWindowsProcessSnapshot({
  snapshot,
  sampledAtMs,
  maximumDistance,
  sampleNumber,
  position
}) {
  const blockers = []
  const processesByPid = new Map()
  const unidentifiedProcessesByPid = new Map()
  const label = `${position} process identity snapshot`
  if (!Number.isFinite(sampledAtMs)) {
    blockers.push(`GPU sample ${sampleNumber} timestamp was missing or invalid`)
  }
  if (!snapshot || typeof snapshot !== 'object') {
    blockers.push(`GPU sample ${sampleNumber} omitted its ${label}`)
    return {
      blockers,
      complete: false,
      processesByPid,
      unidentifiedProcessesByPid,
      snapshotAtMs: Number.NaN,
      startedAtMs: Number.NaN,
      completedAtMs: Number.NaN
    }
  }

  const startedAtMs = timestampMilliseconds(snapshot.startedAt)
  const completedAtMs = timestampMilliseconds(snapshot.completedAt)
  const snapshotAtMs = timestampMilliseconds(snapshot.sampledAt ?? snapshot.completedAt)
  let complete = true
  if (
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(completedAtMs) ||
    !Number.isFinite(snapshotAtMs) ||
    completedAtMs < startedAtMs
  ) {
    blockers.push(`GPU sample ${sampleNumber} ${label} timestamps were invalid`)
    complete = false
  } else {
    const collectionDurationMs = completedAtMs - startedAtMs
    const distanceMs =
      sampledAtMs < startedAtMs
        ? startedAtMs - sampledAtMs
        : sampledAtMs > completedAtMs
          ? sampledAtMs - completedAtMs
          : 0
    if (collectionDurationMs > maximumDistance) {
      blockers.push(
        `GPU sample ${sampleNumber} ${label} took ${collectionDurationMs}ms, beyond the ${maximumDistance}ms coherence limit`
      )
      complete = false
    }
    if (!Number.isFinite(sampledAtMs) || distanceMs > maximumDistance) {
      blockers.push(
        `GPU sample ${sampleNumber} ${label} was ${distanceMs}ms from its GPU counter timestamp`
      )
      complete = false
    }
  }

  if (!Array.isArray(snapshot.processes) || snapshot.processes.length === 0) {
    blockers.push(`GPU sample ${sampleNumber} ${label} contained no Win32_Process rows`)
    complete = false
  } else {
    for (const [index, rawProcess] of snapshot.processes.entries()) {
      const pid = Number(rawProcess?.pid)
      const parentPid = Number(rawProcess?.parentPid)
      const creationDate = normalizeProcessCreationDate(rawProcess?.creationDate)
      if (!Number.isInteger(pid) || pid < 0 || !Number.isInteger(parentPid) || parentPid < 0) {
        blockers.push(
          `GPU sample ${sampleNumber} ${label} Win32_Process row ${index + 1} lacked a valid PID or parent PID`
        )
        complete = false
        continue
      }
      if (processesByPid.has(pid) || unidentifiedProcessesByPid.has(pid)) {
        blockers.push(`GPU sample ${sampleNumber} ${label} duplicated PID ${pid}`)
        complete = false
        continue
      }
      if (pid === 0 || creationDate === null) {
        unidentifiedProcessesByPid.set(pid, {
          pid,
          parentPid,
          creationDate: rawProcess?.creationDate ?? null
        })
        continue
      }
      processesByPid.set(pid, {
        pid,
        parentPid,
        creationDate,
        createdAtMs: timestampMilliseconds(creationDate)
      })
    }
  }
  return {
    blockers,
    complete,
    processesByPid,
    unidentifiedProcessesByPid,
    snapshotAtMs,
    startedAtMs,
    completedAtMs
  }
}

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(ordered.length * ratio) - 1)
  return ordered[index]
}
