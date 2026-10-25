// Build stitchdb-js: ES modules + CommonJS (index, cors, tracing, middleware, jobs), a browser script with the global
// `stitchdb`, and TypeScript declarations.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, rmSync, readFileSync } from 'node:fs'

rmSync('dist', { recursive: true, force: true })
mkdirSync('dist', { recursive: true })
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const banner = { js: `/* stitchdb-js ${version} | MIT | https://stitchdb.com/docs/sdk */` }
const external = ['iceberg-js', '@opentelemetry/api']
const common = { bundle: true, minify: true, sourcemap: true, sourcesContent: false, legalComments: 'none', banner, logLevel: 'error', target: 'es2020' }
// The middleware entry uses the package's own client build instead of bundling a second copy of it.
const ownIndex = (ext) => ({ name: 'own-index', setup(b) { b.onResolve({ filter: /^\.\/index$/ }, (a) => (a.importer.endsWith('middleware.ts') ? { path: `./index.${ext}`, external: true } : undefined)) } })
for (const entry of ['index', 'cors', 'tracing', 'middleware', 'jobs']) {
  await build({ ...common, entryPoints: [`src/${entry}.ts`], format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], external, plugins: [ownIndex('mjs')], outfile: `dist/${entry}.mjs` })
  await build({ ...common, entryPoints: [`src/${entry}.ts`], format: 'cjs', platform: 'node', target: 'node18', external, plugins: [ownIndex('cjs')], outfile: `dist/${entry}.cjs` })
}
// Self-contained ES module for URL imports (Deno, Edge Functions, browsers without a bundler).
await build({ ...common, entryPoints: ['src/index.ts'], format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], outfile: 'dist/stitchdb.mjs' })
await build({ ...common, entryPoints: ['src/middleware.ts'], format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], outfile: 'dist/stitchdb-middleware.mjs' })
await build({ ...common, entryPoints: ['src/jobs.ts'], format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], outfile: 'dist/stitchdb-jobs.mjs' })
// Browser script: everything bundled (including iceberg-js), exposed as window.stitchdb.
await build({ ...common, entryPoints: ['src/index.ts'], format: 'iife', globalName: 'stitchdb', platform: 'browser', outfile: 'dist/stitchdb.js' })

// Declarations (+ the hand-written .d.ts files that tsc does not copy).
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' })
for (const f of readdirSync('src/vendor/phoenix').filter((f) => f.endsWith('.d.ts'))) cpSync(`src/vendor/phoenix/${f}`, `dist/types/vendor/phoenix/${f}`)
cpSync('src/functions/edge-runtime.d.ts', 'dist/types/functions/edge-runtime.d.ts')
console.log(`built stitchdb-js ${version}`)
