// Compile-only check: pipeline() ctx typing, duplicate keys and missing dependencies are type errors.
import { pipeline, defineMiddleware, withCors, withClaims, withRequiredClaims, withStitchClient, withRequestId, withRateLimit } from '../../dist/types/middleware'

const withTenant = defineMiddleware({ key: 'tenant', requires: ['claims'], run: (req, ctx) => ({ id: String(ctx.claims?.sub ?? 'public') }) })

pipeline([withRequestId(), withCors(), withClaims(), withTenant, withStitchClient(), withRateLimit({ limit: 10 })], async (req, ctx) => {
  const id: string = ctx.tenant.id
  const rid: string = ctx.requestId
  const sub: string | undefined = ctx.claims?.sub
  const left: number = ctx.rateLimit.remaining
  ctx.stitch.from('todos').select()
  // @ts-expect-error not in the pipeline
  ctx.stitchAdmin
  return Response.json({ id, rid, sub, left })
})

// @ts-expect-error duplicate key "cors"
pipeline([withCors(), withCors()], async () => new Response('x'))

// @ts-expect-error withRequiredClaims needs withClaims earlier
pipeline([withRequiredClaims(), withClaims()], async () => new Response('x'))

// @ts-expect-error a custom middleware that needs "claims"
pipeline([withTenant], async () => new Response('x'))

// @ts-expect-error the handler must return a Response
pipeline([withCors()], async () => 'text')
