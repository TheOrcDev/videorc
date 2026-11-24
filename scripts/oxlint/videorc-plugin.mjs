// Videorc's own oxlint rules (JS plugin, ESLint rule API). Wired in
// `.oxlintrc.json`.

/** Date methods that read or write the system zone's wall clock. */
const LOCAL_DATE_METHODS = new Set([
  'getDate',
  'getDay',
  'getFullYear',
  'getHours',
  'getMilliseconds',
  'getMinutes',
  'getMonth',
  'getSeconds',
  'getTimezoneOffset',
  'getYear',
  'setDate',
  'setFullYear',
  'setHours',
  'setMilliseconds',
  'setMinutes',
  'setMonth',
  'setSeconds',
  'toLocaleDateString',
  'toLocaleTimeString'
])

const MESSAGE =
  "Electron's tz data lags IANA, so the system local clock can be an hour off. " +
  'Use formatLocal, localDayKey or localOffsetMinutes from @/lib/local-time.'

function propertyName(member) {
  if (member?.type !== 'MemberExpression') return null
  if (!member.computed && member.property.type === 'Identifier') return member.property.name
  if (member.computed && member.property.type === 'Literal') return String(member.property.value)
  return null
}

function isIntlDateTimeFormat(callee) {
  return (
    propertyName(callee) === 'DateTimeFormat' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Intl'
  )
}

function hasTimeZone(options) {
  return options.properties.some(
    (property) =>
      property.type === 'Property' &&
      ((property.key.type === 'Identifier' && property.key.name === 'timeZone') ||
        (property.key.type === 'Literal' && property.key.value === 'timeZone'))
  )
}

const noSystemLocalTime = {
  meta: {
    type: 'problem',
    docs: { description: 'Read local times through @/lib/local-time, never the system zone.' }
  },
  create(context) {
    if (/\.test\.[cm]?[jt]sx?$/.test(context.filename ?? '')) return {}
    // `Intl.DateTimeFormat().resolvedOptions()` only reads the zone's name.
    const readsZoneName = new Set()
    const checkFormat = (node) => {
      if (!isIntlDateTimeFormat(node.callee) || readsZoneName.has(node)) return
      const options = node.arguments[1]
      if (!options || (options.type === 'ObjectExpression' && !hasTimeZone(options))) {
        context.report({ node, message: `Intl.DateTimeFormat without a timeZone. ${MESSAGE}` })
      }
    }
    return {
      MemberExpression(node) {
        if (
          propertyName(node) === 'resolvedOptions' &&
          (node.object.type === 'CallExpression' || node.object.type === 'NewExpression')
        ) {
          readsZoneName.add(node.object)
        }
      },
      NewExpression: checkFormat,
      CallExpression(node) {
        checkFormat(node)
        const name = propertyName(node.callee)
        if (!name) return
        const onNewDate =
          name === 'toLocaleString' &&
          node.callee.object.type === 'NewExpression' &&
          node.callee.object.callee.type === 'Identifier' &&
          node.callee.object.callee.name === 'Date'
        if (LOCAL_DATE_METHODS.has(name) || onNewDate) {
          context.report({ node, message: `${name}() uses the system time zone. ${MESSAGE}` })
        }
      }
    }
  }
}

export default {
  meta: { name: 'videorc' },
  rules: { 'no-system-local-time': noSystemLocalTime }
}
