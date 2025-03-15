#!/usr/bin/env node
import { build } from 'esbuild'
import UnpluginTypia from '@ryoppippi/unplugin-typia/esbuild'

const [, , inputFile] = process.argv

if (!inputFile) {
  console.error('Please provide an input file')
  process.exit(1)
}

const outputFile = 'dist/' + inputFile.replace('.ts', '.js')

build({
  entryPoints: [inputFile],
  outfile: outputFile,
  plugins: [UnpluginTypia({
    cache: true,
  })],
  platform: 'node',
  bundle: true,
  target: 'node16',
  format: 'cjs',
  external: ['uWebSockets.js'],
})
  .then(() => {
    console.log(`Compiled ${inputFile} to ${outputFile}`)
    import('child_process').then(({ execSync }) => {
      execSync(`node ${outputFile}`, { stdio: 'inherit' })
    })
  })
  .catch(error => {
    console.error('Error building:', error)
    process.exit(1)
  })
