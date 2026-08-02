import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  attributeWindowsGpuSamplesToProcessTimeline,
  normalizeWindowsGpuCounterBatch,
  normalizeWindowsProcessIdentityBracket,
  parseWindowsGpuCounterInstance,
  summarizeWindowsGpuSamples,
  windowsGpuCounterPowerShellScript
} from './windows-gpu-sampler.mjs'

const ADAPTER = '0x00000000:0x0000abcd'
const ROOT_CREATED = '2026-07-29T11:59:55.000Z'
const CHILD_CREATED = '2026-07-29T11:59:56.000Z'
const SYSTEM_CREATED = '2026-07-29T10:00:00.000Z'

describe('Windows GPU sampler', () => {
  it('parses PID, adapter LUID, and engine type from Windows counter instances', () => {
    assert.deepEqual(
      parseWindowsGpuCounterInstance(
        'pid_4321_luid_0x00000000_0x0000ABCD_phys_0_eng_1_engtype_VideoEncode'
      ),
      {
        pid: 4321,
        adapterLuid: ADAPTER,
        engineType: 'videoencode'
      }
    )
    assert.equal(parseWindowsGpuCounterInstance('not-a-gpu-instance'), null)
  })

  it('uses the maximum concurrent engine and aggregates process-tree memory', () => {
    const result = summarizeWindowsGpuSamples({
      samples: [
        sample({
          engines: [
            engine(101, '3D', 65),
            engine(101, 'Copy', 20),
            engine(202, 'VideoEncode', 70),
            engine(202, 'VideoDecode', 5)
          ],
          memory: [memory(101, 100, 25), memory(202, 200, 50)]
        })
      ],
      expectedSamples: 1,
      processIds: [101, 202],
      adapterLuid: ADAPTER
    })

    assert.equal(result.verdict, 'PASS')
    assert.equal(result.summary.engineBusyP95Percent, 70)
    assert.equal(result.summary.dedicatedP95MiB, 300)
    assert.equal(result.summary.sharedMaxMiB, 75)
  })

  it('derives descendants from the candidate root identity and preserves system GPU counters', () => {
    const start = Date.parse('2026-07-29T12:00:00.000Z')
    const attributed = attributeWindowsGpuSamplesToProcessTimeline({
      samples: [
        coherentSample({
          timestamp: start,
          processes: [
            processRow(4, 0, SYSTEM_CREATED),
            processRow(101, 4, ROOT_CREATED),
            processRow(202, 101, CHILD_CREATED),
            processRow(999, 4, SYSTEM_CREATED)
          ],
          engines: [engine(101, '3D', 20), engine(202, 'VideoEncode', 70), engine(999, 'Copy', 90)],
          memory: [memory(101, 64, 16), memory(202, 32, 8), memory(999, 512, 128)]
        })
      ],
      candidateRootPid: 101,
      candidateRootCreationDate: ROOT_CREATED,
      expectedSamples: 1,
      intervalMs: 1_000
    })

    assert.equal(attributed.verdict, 'PASS')
    assert.deepEqual(attributed.processIds, [101, 202])
    assert.equal(attributed.samples[0].engineCounters.length, 2)
    assert.equal(attributed.samples[0].memoryCounters.length, 2)
    assert.equal(attributed.samples[0].systemEngineCounters.length, 1)
    assert.equal(attributed.samples[0].systemMemoryCounters.length, 1)
    assert.deepEqual(attributed.samples[0].processOwnership.systemGpuPids, [999])
    assert.deepEqual(attributed.samples[0].processOwnership.unknownGpuPids, [])
  })

  it('does not inherit ownership through a stale reused parent PID', () => {
    const start = Date.parse('2026-07-29T12:00:00.000Z')
    const attributed = attributeWindowsGpuSamplesToProcessTimeline({
      samples: [
        coherentSample({
          timestamp: start,
          processes: [
            processRow(101, 4, ROOT_CREATED),
            // This process predates the candidate, so its ParentProcessId=101
            // names an older process that previously held the candidate PID.
            processRow(999, 101, SYSTEM_CREATED)
          ],
          engines: [engine(101, '3D', 20), engine(999, 'Copy', 90)],
          memory: [memory(101, 64, 16), memory(999, 512, 128)]
        })
      ],
      candidateRootPid: 101,
      candidateRootCreationDate: ROOT_CREATED,
      expectedSamples: 1,
      intervalMs: 1_000
    })

    assert.equal(attributed.verdict, 'PASS')
    assert.deepEqual(attributed.processIds, [101])
    assert.deepEqual(attributed.samples[0].processOwnership.systemGpuPids, [999])
  })

  it('blocks root and child PID reuse without reclassifying the replacement', () => {
    const start = Date.parse('2026-07-29T12:00:00.000Z')
    const reusedAt = '2026-07-29T12:00:00.500Z'
    const childReuse = attributeWindowsGpuSamplesToProcessTimeline({
      samples: [
        coherentSample({
          timestamp: start,
          processes: [processRow(101, 4, ROOT_CREATED), processRow(202, 101, CHILD_CREATED)],
          engines: [engine(202, 'VideoEncode', 70)],
          memory: [memory(202, 32, 8)]
        }),
        coherentSample({
          timestamp: start + 1_000,
          processes: [processRow(101, 4, ROOT_CREATED), processRow(202, 4, reusedAt)],
          engines: [engine(202, 'Copy', 80)],
          memory: [memory(202, 16, 4)]
        })
      ],
      candidateRootPid: 101,
      candidateRootCreationDate: ROOT_CREATED,
      expectedSamples: 2,
      intervalMs: 1_000
    })

    assert.equal(childReuse.verdict, 'BLOCKED')
    assert.match(childReuse.blockers.join('\n'), /PID reuse for previously app-owned PID 202/)
    assert.deepEqual(childReuse.samples[1].engineCounters, [])
    assert.equal(childReuse.samples[1].unknownEngineCounters.length, 1)

    const rootReuse = attributeWindowsGpuSamplesToProcessTimeline({
      samples: [
        coherentSample({
          timestamp: start,
          processes: [processRow(101, 4, reusedAt)],
          engines: [engine(101, '3D', 20)],
          memory: [memory(101, 64, 16)]
        })
      ],
      candidateRootPid: 101,
      candidateRootCreationDate: ROOT_CREATED,
      expectedSamples: 1,
      intervalMs: 1_000
    })

    assert.equal(rootReuse.verdict, 'BLOCKED')
    assert.match(rootReuse.blockers.join('\n'), /candidate root PID 101 was reused/)
    assert.deepEqual(rootReuse.samples[0].engineCounters, [])
  })

  it('blocks PID reuse that occurs inside the counter identity bracket', () => {
    const start = Date.parse('2026-07-29T12:00:00.000Z')
    const reusedAt = '2026-07-29T11:59:59.999Z'
    const attributed = attributeWindowsGpuSamplesToProcessTimeline({
      samples: [
        coherentSample({
          timestamp: start,
          beforeProcesses: [processRow(101, 4, ROOT_CREATED), processRow(202, 101, CHILD_CREATED)],
          afterProcesses: [processRow(101, 4, ROOT_CREATED), processRow(202, 101, reusedAt)],
          engines: [engine(202, 'VideoEncode', 70)],
          memory: [memory(202, 32, 8)]
        })
      ],
      candidateRootPid: 101,
      candidateRootCreationDate: ROOT_CREATED,
      expectedSamples: 1,
      intervalMs: 1_000
    })

    assert.equal(attributed.verdict, 'BLOCKED')
    assert.match(attributed.blockers.join('\n'), /PID 202 changed CreationDate inside/)
    assert.deepEqual(attributed.samples[0].engineCounters, [])
    assert.equal(attributed.samples[0].unknownEngineCounters.length, 1)
    assert.deepEqual(attributed.samples[0].processOwnership.unknownGpuPids, [202])
  })

  it('blocks GPU processes that start or exit inside the identity bracket', () => {
    const start = Date.parse('2026-07-29T12:00:00.000Z')
    const attributed = attributeWindowsGpuSamplesToProcessTimeline({
      samples: [
        coherentSample({
          timestamp: start,
          beforeProcesses: [processRow(101, 4, ROOT_CREATED), processRow(303, 101, CHILD_CREATED)],
          afterProcesses: [
            processRow(101, 4, ROOT_CREATED),
            processRow(404, 101, '2026-07-29T12:00:00.001Z')
          ],
          engines: [engine(303, 'Copy', 40), engine(404, '3D', 50)],
          memory: [memory(303, 16, 4), memory(404, 32, 8)]
        })
      ],
      candidateRootPid: 101,
      candidateRootCreationDate: ROOT_CREATED,
      expectedSamples: 1,
      intervalMs: 1_000
    })

    assert.equal(attributed.verdict, 'BLOCKED')
    assert.match(attributed.blockers.join('\n'), /PID 303.*did not span both sides/)
    assert.match(attributed.blockers.join('\n'), /PID 404.*did not span both sides/)
    assert.equal(attributed.samples[0].unknownEngineCounters.length, 2)
    assert.deepEqual(attributed.samples[0].processOwnership.unknownGpuPids, [303, 404])
  })

  it('blocks ambiguous child churn and lingering counters for an exited owned child', () => {
    const start = Date.parse('2026-07-29T12:00:00.000Z')
    const attributed = attributeWindowsGpuSamplesToProcessTimeline({
      samples: [
        coherentSample({
          timestamp: start,
          processes: [processRow(101, 4, ROOT_CREATED), processRow(202, 101, CHILD_CREATED)],
          engines: [engine(202, 'VideoEncode', 70)],
          memory: [memory(202, 32, 8)]
        }),
        coherentSample({
          timestamp: start + 1_000,
          processes: [
            processRow(101, 4, ROOT_CREATED),
            processRow(303, 202, '2026-07-29T12:00:00.250Z')
          ],
          engines: [engine(202, 'VideoEncode', 80), engine(303, 'Copy', 40)],
          memory: [memory(202, 32, 8), memory(303, 16, 4)]
        })
      ],
      candidateRootPid: 101,
      candidateRootCreationDate: ROOT_CREATED,
      expectedSamples: 2,
      intervalMs: 1_000
    })

    assert.equal(attributed.verdict, 'BLOCKED')
    assert.match(attributed.blockers.join('\n'), /unrelated-system ownership for GPU PID 303/)
    assert.match(attributed.blockers.join('\n'), /PID 202.*did not span both sides/)
    assert.deepEqual(attributed.samples[1].engineCounters, [])
    assert.equal(attributed.samples[1].unknownEngineCounters.length, 2)
    assert.deepEqual(attributed.samples[1].processOwnership.unknownGpuPids, [202, 303])
  })

  it('blocks a never-seen GPU PID absent from the coherent process snapshot', () => {
    const start = Date.parse('2026-07-29T12:00:00.000Z')
    const attributed = attributeWindowsGpuSamplesToProcessTimeline({
      samples: [
        coherentSample({
          timestamp: start,
          processes: [processRow(101, 4, ROOT_CREATED)],
          engines: [engine(101, '3D', 20), engine(777, 'Copy', 90)],
          memory: [memory(101, 64, 16), memory(777, 512, 128)]
        })
      ],
      candidateRootPid: 101,
      candidateRootCreationDate: ROOT_CREATED,
      expectedSamples: 1,
      intervalMs: 1_000
    })

    assert.equal(attributed.verdict, 'BLOCKED')
    assert.match(
      attributed.blockers.join('\n'),
      /PID 777, whose identity did not span both sides of the counter bracket/
    )
    assert.equal(attributed.samples[0].unknownEngineCounters.length, 1)
    assert.equal(attributed.samples[0].unknownMemoryCounters.length, 1)
    assert.deepEqual(attributed.samples[0].processOwnership.unknownGpuPids, [777])
  })

  it('fails closed on engine, dedicated-memory, and shared-memory PDH statuses', () => {
    const start = Date.parse('2026-07-29T12:00:00.000Z')
    const attributed = attributeWindowsGpuSamplesToProcessTimeline({
      samples: [
        coherentSample({
          timestamp: start,
          processes: [processRow(101, 4, ROOT_CREATED)],
          engines: [engine(101, '3D', 20, ADAPTER, 0x8000_07d5)],
          memory: [
            memory(101, 64, 16, ADAPTER, {
              dedicatedStatus: 0xc000_0bb8,
              sharedStatus: 0x8000_07d1
            })
          ]
        })
      ],
      candidateRootPid: 101,
      candidateRootCreationDate: ROOT_CREATED,
      expectedSamples: 1,
      intervalMs: 1_000
    })

    assert.equal(attributed.verdict, 'BLOCKED')
    assert.match(attributed.blockers.join('\n'), /engine counter for PID 101.*0x800007d5/)
    assert.match(attributed.blockers.join('\n'), /dedicated-usage.*0xc0000bb8/)
    assert.match(attributed.blockers.join('\n'), /shared-usage.*0x800007d1/)
    assert.equal(
      summarizeWindowsGpuSamples({
        samples: attributed.samples,
        expectedSamples: 1,
        processIds: attributed.processIds,
        adapterLuid: ADAPTER
      }).verdict,
      'BLOCKED'
    )
  })

  it('accepts PDH valid-data and new-data statuses', () => {
    const start = Date.parse('2026-07-29T12:00:00.000Z')
    const attributed = attributeWindowsGpuSamplesToProcessTimeline({
      samples: [
        coherentSample({
          timestamp: start,
          engines: [engine(101, '3D', 20, ADAPTER, 1)],
          memory: [
            memory(101, 64, 16, ADAPTER, {
              dedicatedStatus: 0,
              sharedStatus: 1
            })
          ]
        })
      ],
      candidateRootPid: 101,
      candidateRootCreationDate: ROOT_CREATED,
      expectedSamples: 1,
      intervalMs: 1_000
    })
    const summary = summarizeWindowsGpuSamples({
      samples: attributed.samples,
      expectedSamples: 1,
      processIds: attributed.processIds,
      adapterLuid: ADAPTER
    })

    assert.equal(attributed.verdict, 'PASS')
    assert.equal(summary.verdict, 'PASS')
  })

  it('requires each GPU batch to carry a nearby complete process snapshot', () => {
    const start = Date.parse('2026-07-29T12:00:00.000Z')
    const attributed = attributeWindowsGpuSamplesToProcessTimeline({
      samples: [
        sample(),
        coherentSample({
          timestamp: start + 1_000,
          snapshotStartedAt: start + 4_000,
          snapshotCompletedAt: start + 4_100,
          processes: [processRow(101, 4, ROOT_CREATED)]
        })
      ],
      candidateRootPid: 101,
      candidateRootCreationDate: ROOT_CREATED,
      expectedSamples: 2,
      intervalMs: 1_000,
      maximumSampleDistanceMs: 500
    })

    assert.equal(attributed.verdict, 'BLOCKED')
    assert.match(attributed.blockers.join('\n'), /omitted its timestamp-coherent process snapshot/)
    assert.match(attributed.blockers.join('\n'), /process snapshot was 3000ms/)
    assert.match(attributed.blockers.join('\n'), /coverage 0\/2/)
  })

  it('pins root CreationDate from the first coherent snapshot when the caller omits it', () => {
    const start = Date.parse('2026-07-29T12:00:00.000Z')
    const attributed = attributeWindowsGpuSamplesToProcessTimeline({
      samples: [
        coherentSample({
          timestamp: start,
          processes: [processRow(101, 4, ROOT_CREATED)]
        })
      ],
      candidateRootPid: 101,
      expectedSamples: 1,
      intervalMs: 1_000
    })

    assert.equal(attributed.verdict, 'PASS')
    assert.deepEqual(attributed.rootProcess, {
      pid: 101,
      creationDate: ROOT_CREATED,
      identitySource: 'first-process-identity-bracket'
    })
  })

  it('canonicalizes Windows PowerShell DateTime JSON when pinning the candidate root', () => {
    const start = Date.parse('2026-07-29T12:00:00.000Z')
    const rootCreatedMs = Date.parse(ROOT_CREATED)
    const attributed = attributeWindowsGpuSamplesToProcessTimeline({
      samples: [
        coherentSample({
          timestamp: start,
          processes: [processRow(101, 4, '2026-07-29T11:59:55.0000000Z')]
        })
      ],
      candidateRootPid: 101,
      candidateRootCreationDate: `/Date(${rootCreatedMs})/`,
      expectedSamples: 1,
      intervalMs: 1_000
    })

    assert.equal(attributed.verdict, 'PASS')
    assert.equal(attributed.rootProcess.creationDate, ROOT_CREATED)
  })

  it('rejects the old PID-only nearest-timeline attribution contract', () => {
    const start = Date.parse('2026-07-29T12:00:00.000Z')
    const attributed = attributeWindowsGpuSamplesToProcessTimeline({
      samples: [sample()],
      timeline: {
        expectedSamples: 1,
        intervalMs: 1_000,
        rootPid: 101,
        observations: [{ sampledAtMs: start, processIds: [101] }]
      }
    })

    assert.equal(attributed.verdict, 'BLOCKED')
    assert.match(attributed.blockers.join('\n'), /omitted its pre\/post timestamp-coherent/)
  })

  it('requires at least 90 percent complete samples at the inclusive boundary', () => {
    const nine = Array.from({ length: 9 }, () => sample())
    assert.equal(
      summarizeWindowsGpuSamples({
        samples: nine,
        expectedSamples: 10,
        processIds: [101],
        adapterLuid: ADAPTER
      }).verdict,
      'PASS'
    )
    assert.match(
      summarizeWindowsGpuSamples({
        samples: nine.slice(0, 8),
        expectedSamples: 10,
        processIds: [101],
        adapterLuid: ADAPTER
      }).blockers.join('\n'),
      /below the required 90%/
    )
  })

  it('blocks unattributed PIDs, adapter drift, missing counters, and non-finite units', () => {
    const result = summarizeWindowsGpuSamples({
      samples: [
        sample({ engines: [engine(999, '3D', 10)] }),
        sample({
          engines: [engine(101, '3D', 10, '0x00000000:0x0000beef')]
        }),
        { timestamp: 'now', engineCounters: [], memoryCounters: null },
        sample({ memory: [memory(101, Number.NaN, 1)] })
      ],
      expectedSamples: 4,
      processIds: [101],
      adapterLuid: ADAPTER
    })

    assert.equal(result.verdict, 'BLOCKED')
    assert.match(result.blockers.join('\n'), /outside the attributed/)
    assert.match(result.blockers.join('\n'), /different adapter/)
    assert.match(result.blockers.join('\n'), /missing engine or process-memory/)
    assert.match(result.blockers.join('\n'), /non-finite/)
  })

  it('generates one vendor-neutral counter and Win32_Process snapshot collector', () => {
    const script = windowsGpuCounterPowerShellScript({
      intervalSeconds: 1,
      maxSamples: 180
    })
    assert.match(script, /GPU Engine\(\*\).*Utilization Percentage/)
    assert.match(script, /GPU Process Memory\(\*\).*Dedicated Usage/)
    assert.match(script, /GPU Process Memory\(\*\).*Shared Usage/)
    assert.match(script, /-SampleInterval 1 -MaxSamples 180/)
    assert.match(script, /Get-CimInstance -ClassName Win32_Process/)
    assert.match(script, /ProcessId, ParentProcessId, CreationDate/)
    assert.match(script, /processSnapshot =/)
    assert.match(script, /processSnapshotStartedAt/)
    assert.match(script, /processSnapshotCompletedAt/)
  })

  it('normalizes raw counters and their coherent Win32_Process snapshot', () => {
    const engineInstance = instance(101, '3D')
    const memoryInstance = instance(101, null)
    const processSnapshot = snapshot('2026-07-29T12:00:00.000Z', [processRow(101, 4, ROOT_CREATED)])
    assert.deepEqual(
      normalizeWindowsGpuCounterBatch({
        timestamp: 'now',
        processSnapshot,
        counters: [
          {
            path: `\\\\host\\gpu engine(${engineInstance})\\utilization percentage`,
            instanceName: engineInstance,
            value: 42
          },
          {
            path: `\\\\host\\gpu process memory(${memoryInstance})\\dedicated usage`,
            instanceName: memoryInstance,
            value: 100
          },
          {
            path: `\\\\host\\gpu process memory(${memoryInstance})\\shared usage`,
            instanceName: memoryInstance,
            value: 50
          }
        ]
      }),
      {
        timestamp: 'now',
        processSnapshot,
        engineCounters: [{ instanceName: engineInstance, value: 42 }],
        memoryCounters: [{ instanceName: memoryInstance, dedicatedBytes: 100, sharedBytes: 50 }]
      }
    )
  })

  it('retains invalid process identity fields for fail-closed attribution', () => {
    assert.deepEqual(
      normalizeWindowsProcessSnapshot({
        sampledAt: 'now',
        startedAt: 'before',
        completedAt: 'after',
        processes: [{ pid: '202', parentPid: '101', creationDate: null }]
      }),
      {
        sampledAt: 'now',
        startedAt: 'before',
        completedAt: 'after',
        processes: [{ pid: 202, parentPid: 101, creationDate: null }]
      }
    )
  })
})

function sample({
  engines = [engine(101, '3D', 50)],
  memory: memoryRows = [memory(101, 128, 32)]
} = {}) {
  return {
    timestamp: '2026-07-29T12:00:00.000Z',
    engineCounters: engines,
    memoryCounters: memoryRows
  }
}

function coherentSample({
  timestamp,
  processes = [processRow(101, 4, ROOT_CREATED)],
  beforeProcesses = processes,
  afterProcesses = processes,
  engines = [engine(101, '3D', 50)],
  memory: memoryRows = [memory(101, 128, 32)],
  beforeSnapshotStartedAt = timestamp - 20,
  beforeSnapshotCompletedAt = timestamp - 10,
  afterSnapshotStartedAt = timestamp + 10,
  afterSnapshotCompletedAt = timestamp + 20
}) {
  return {
    timestamp: new Date(timestamp).toISOString(),
    processIdentityBracket: {
      before: snapshot(
        new Date(beforeSnapshotCompletedAt).toISOString(),
        beforeProcesses,
        new Date(beforeSnapshotStartedAt).toISOString()
      ),
      after: snapshot(
        new Date(afterSnapshotCompletedAt).toISOString(),
        afterProcesses,
        new Date(afterSnapshotStartedAt).toISOString()
      )
    },
    engineCounters: engines,
    memoryCounters: memoryRows
  }
}

function snapshot(completedAt, processes, startedAt = completedAt) {
  return {
    sampledAt: completedAt,
    startedAt,
    completedAt,
    processes
  }
}

function processRow(pid, parentPid, creationDate) {
  return { pid, parentPid, creationDate }
}

function instance(pid, engineType, adapter = ADAPTER) {
  const [high, low] = adapter.split(':')
  return `pid_${pid}_luid_${high}_${low}_phys_0${engineType ? `_eng_0_engtype_${engineType}` : ''}`
}

function engine(pid, engineType, value, adapter = ADAPTER, status = 0) {
  return { instanceName: instance(pid, engineType, adapter), value, status }
}

function memory(
  pid,
  dedicatedMiB,
  sharedMiB,
  adapter = ADAPTER,
  { dedicatedStatus = 0, sharedStatus = 0 } = {}
) {
  return {
    instanceName: instance(pid, null, adapter),
    dedicatedBytes: dedicatedMiB * 1024 * 1024,
    dedicatedStatus,
    sharedBytes: sharedMiB * 1024 * 1024,
    sharedStatus
  }
}
