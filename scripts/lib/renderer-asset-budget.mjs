import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

export async function measureEagerRendererAssets({ htmlPath }) {
  const absoluteHtmlPath = resolve(htmlPath)
  const root = dirname(absoluteHtmlPath)
  const html = await readFile(absoluteHtmlPath, 'utf8')
  const references = eagerJavascriptReferences(html)
  const assets = []
  for (const reference of references) {
    const path = resolve(root, reference)
    if (relative(root, path).startsWith('..')) {
      throw new Error(`Eager renderer asset escaped output root: ${reference}`)
    }
    const bytes = await readFile(path)
    assets.push({
      reference,
      rawBytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes).byteLength,
      entry: /<script[^>]+src=["'][^"']+["']/i.test(
        html.match(
          new RegExp(`<script[^>]+src=["'][^"']*${escapeRegExp(reference)}["'][^>]*>`, 'i')
        )?.[0] ?? ''
      )
    })
  }
  const entry = assets.find((asset) => asset.entry) ?? null
  return {
    htmlPath: absoluteHtmlPath,
    assets,
    eagerAssetCount: assets.length,
    totalRawBytes: assets.reduce((total, asset) => total + asset.rawBytes, 0),
    totalGzipBytes: assets.reduce((total, asset) => total + asset.gzipBytes, 0),
    entryRawBytes: entry?.rawBytes ?? null,
    entryGzipBytes: entry?.gzipBytes ?? null
  }
}

export function evaluateRendererAssetBudget(measurement, budget) {
  const failures = []
  addBudgetFailure(
    failures,
    'initial eager JavaScript raw bytes',
    measurement.totalRawBytes,
    budget.maxTotalRawBytes
  )
  addBudgetFailure(
    failures,
    'initial eager JavaScript gzip bytes',
    measurement.totalGzipBytes,
    budget.maxTotalGzipBytes
  )
  addBudgetFailure(
    failures,
    'main entry raw bytes',
    measurement.entryRawBytes,
    budget.maxEntryRawBytes
  )
  addBudgetFailure(
    failures,
    'main entry gzip bytes',
    measurement.entryGzipBytes,
    budget.maxEntryGzipBytes
  )
  return failures
}

export function eagerJavascriptReferences(html) {
  const references = new Set()
  for (const match of html.matchAll(
    /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+\.js)["'][^>]*>/gi
  )) {
    references.add(match[1])
  }
  for (const match of html.matchAll(
    /<script\b[^>]*\bsrc=["']([^"']+\.js)["'][^>]*\btype=["']module["'][^>]*>/gi
  )) {
    references.add(match[1])
  }
  for (const match of html.matchAll(
    /<link\b[^>]*\brel=["']modulepreload["'][^>]*\bhref=["']([^"']+\.js)["'][^>]*>/gi
  )) {
    references.add(match[1])
  }
  for (const match of html.matchAll(
    /<link\b[^>]*\bhref=["']([^"']+\.js)["'][^>]*\brel=["']modulepreload["'][^>]*>/gi
  )) {
    references.add(match[1])
  }
  return [...references]
}

function addBudgetFailure(failures, label, actual, maximum) {
  if (!Number.isFinite(actual)) {
    failures.push(`${label} was not measured`)
  } else if (actual > maximum) {
    failures.push(`${label} ${actual} exceeded ${maximum}`)
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
