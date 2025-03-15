#!/usr/bin/env node
import { build } from 'esbuild'
import UnpluginTypia from '@ryoppippi/unplugin-typia/esbuild'
import { execSync } from 'node:child_process'

const [, , inputFile] = process.argv

if (!inputFile) {
  console.error('Please provide an input file')
  process.exit(1)
}

const outputFile = 'dist/' + inputFile.replace('.ts', '.js')

build({
  entryPoints: [inputFile],
  // outfile: outputFile,
  outdir: 'dist',
  plugins: [
    UnpluginTypia({
      cache: true,
    }),
  ],
  platform: 'node',
  bundle: true,
  sourcemap: true,
  minify: true,
  target: 'node16',
  format: 'cjs',
  external: ['uWebSockets.js'],
})
  .then(() => {
    console.log(`Compiled ${inputFile} to ${outputFile}`)
    execSync(`node ${outputFile}`, { stdio: 'inherit' })
    // execSync(`node --enable-source-maps --prof ${outputFile}`, { stdio: 'inherit' })
    // $ node --prof-process isolate-0x58a58b0-184630-v8.log > profile.txt
  })
  .catch(error => {
    console.error('Error building:', error)
    process.exit(1)
  })
