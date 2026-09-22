import { build } from 'esbuild'

await build({
  entryPoints: ['management-center/management-app.jsx'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  outfile: 'management-center/public/management-app.js',
  sourcemap: false,
  minify: false,
  legalComments: 'none'
})

process.stdout.write('Built management-center/public/management-app.js\n')
