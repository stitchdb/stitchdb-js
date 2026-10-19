/**
 * W3C Trace Context helpers used by `tracePropagation` (see `stitchdb-js/tracing`).
 * Trace headers are only attached to requests for the project host, StitchDB domains and localhost.
 */

/** Trace headers read from the active OpenTelemetry context. */
export interface TraceContext {
  traceparent?: string
  tracestate?: string
  baggage?: string
  /** Keys a non-W3C propagator wrote (reported when there is no `traceparent`). */
  carrierKeys?: string[]
}
export type TraceExtractionResult = TraceContext
/** Returns the current trace headers, or null when there is no active trace. */
export type TraceContextExtractor = () => TraceContext | null
/** Hostname (exact or `*.example.com`), a RegExp tested against the hostname, or a predicate. */
export type TracePropagationTarget = string | RegExp | ((url: URL) => boolean)

export interface ParsedTraceParent {
  version: string
  traceId: string
  parentId: string
  traceFlags: string
  isSampled: boolean
}

/** Parse a W3C `traceparent` header (`version-traceid-parentid-traceflags`); null when invalid. */
export function parseTraceParent(traceparent: string | null | undefined): ParsedTraceParent | null {
  if (!traceparent || typeof traceparent !== 'string') return null
  const parts = traceparent.split('-')
  if (parts.length !== 4) return null
  const [version, traceId, parentId, traceFlags] = parts
  if (version.length !== 2 || traceId.length !== 32 || parentId.length !== 16 || traceFlags.length !== 2) return null
  const hex = /^[0-9a-f]+$/i
  if (!hex.test(version) || !hex.test(traceId) || !hex.test(parentId) || !hex.test(traceFlags)) return null
  if (traceId === '00000000000000000000000000000000' || parentId === '0000000000000000') return null
  const isSampled = (parseInt(traceFlags, 16) & 0x01) === 0x01
  return { version, traceId, parentId, traceFlags, isSampled }
}

function matchStringTarget(hostname: string, target: string): boolean {
  if (target === hostname) return true
  if (target.startsWith('*.')) {
    const domain = target.slice(2)
    if (hostname === domain || hostname.endsWith('.' + domain)) return true
  }
  return false
}

/** Whether trace headers may be sent to `targetUrl`. Wildcards are matched without regular expressions. */
export function shouldPropagateToTarget(targetUrl: string | URL, targets: TracePropagationTarget[]): boolean {
  if (!targetUrl || !targets || targets.length === 0) return false
  let url: URL
  if (targetUrl instanceof URL) url = targetUrl
  else {
    try {
      url = new URL(targetUrl)
    } catch {
      return false
    }
  }
  for (const target of targets) {
    try {
      if (typeof target === 'string') {
        if (matchStringTarget(url.hostname, target)) return true
      } else if (target instanceof RegExp) {
        if (target.test(url.hostname)) return true
      } else if (typeof target === 'function') {
        if (target(url)) return true
      }
    } catch {
      continue
    }
  }
  return false
}

/** Default targets: the project host, StitchDB domains and local development hosts. */
export function getDefaultPropagationTargets(projectUrl: string): TracePropagationTarget[] {
  const targets: TracePropagationTarget[] = []
  try {
    targets.push(new URL(projectUrl).hostname)
  } catch {
    // invalid URL: no exact host target
  }
  targets.push('*.stitchdb.com', 'localhost', '127.0.0.1', '[::1]')
  return targets
}

interface OtelLike {
  propagation: { inject(context: unknown, carrier: Record<string, string>): void }
  context: { active(): unknown }
}
/** Build an extractor from the OpenTelemetry API (`propagation` + `context`). */
export function createTraceContextExtractor(otel: OtelLike): TraceContextExtractor {
  return () => {
    try {
      const carrier: Record<string, string> = {}
      otel.propagation.inject(otel.context.active(), carrier)
      const traceparent = carrier['traceparent']
      if (!traceparent) {
        const carrierKeys = Object.keys(carrier)
        return carrierKeys.length === 0 ? null : { carrierKeys }
      }
      return { traceparent, tracestate: carrier['tracestate'], baggage: carrier['baggage'] }
    } catch {
      return null
    }
  }
}
