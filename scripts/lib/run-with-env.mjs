import { basename, delimiter as defaultPathDelimiter } from 'node:path'

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const WINDOWS_SHELL_COMMANDS = new Set([
  'corepack',
  'npm',
  'npx',
  'pnpm',
  'pnpx',
  'yarn',
  'yarnpkg'
])

export function parseRunWithEnvArgs(argv) {
  const separatorIndex = argv.indexOf('--')
  if (separatorIndex === -1) {
    throw new Error('run-with-env requires `--` before the command.')
  }

  const setupArgs = argv.slice(0, separatorIndex)
  const commandArgs = argv.slice(separatorIndex + 1)
  const command = commandArgs.shift()
  if (!command) {
    throw new Error('run-with-env requires a command after `--`.')
  }

  const environment = {}
  const prependPath = []
  let requiredPlatform = null

  for (const argument of setupArgs) {
    if (argument.startsWith('--platform=')) {
      if (requiredPlatform !== null) {
        throw new Error('run-with-env accepts only one --platform option.')
      }
      requiredPlatform = argument.slice('--platform='.length).trim()
      if (!requiredPlatform) {
        throw new Error('run-with-env --platform cannot be empty.')
      }
      continue
    }

    if (argument.startsWith('--prepend-path=')) {
      const path = argument.slice('--prepend-path='.length)
      if (!path) {
        throw new Error('run-with-env --prepend-path cannot be empty.')
      }
      prependPath.push(path)
      continue
    }

    const equalsIndex = argument.indexOf('=')
    if (equalsIndex < 1) {
      throw new Error(`Invalid environment assignment: ${argument}`)
    }
    const name = argument.slice(0, equalsIndex)
    const value = argument.slice(equalsIndex + 1)
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`)
    }
    if (value.includes('\0')) {
      throw new Error(`Environment variable ${name} contains a NUL byte.`)
    }
    environment[name] = value
  }

  return { command, commandArgs, environment, prependPath, requiredPlatform }
}

export function assertRequiredPlatform(requiredPlatform, actualPlatform = process.platform) {
  if (requiredPlatform && requiredPlatform !== actualPlatform) {
    throw new Error(
      `This command requires ${requiredPlatform}; current platform is ${actualPlatform}. ` +
        'Use the corresponding platform-specific gate instead.'
    )
  }
}

export function createRunEnvironment(
  { environment = {}, prependPath = [] },
  {
    baseEnvironment = process.env,
    platform = process.platform,
    pathDelimiter = defaultPathDelimiter
  } = {}
) {
  const result = { ...baseEnvironment, ...environment }
  if (prependPath.length === 0) return result

  const pathName = environmentPathName(result, platform)
  const currentPath = result[pathName]
  result[pathName] = [...prependPath, ...(currentPath ? [currentPath] : [])].join(pathDelimiter)
  return result
}

export function commandNeedsShell(command, platform = process.platform) {
  if (platform !== 'win32') return false
  const commandName = basename(command).toLowerCase()
  return (
    WINDOWS_SHELL_COMMANDS.has(commandName) ||
    commandName.endsWith('.cmd') ||
    commandName.endsWith('.bat')
  )
}

function environmentPathName(environment, platform) {
  if (platform !== 'win32') return 'PATH'
  return Object.keys(environment).find((name) => name.toLowerCase() === 'path') ?? 'Path'
}
