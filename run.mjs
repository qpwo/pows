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

async function main() {
  await build({
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
  console.log(`Compiled ${inputFile} to ${outputFile}`)
  const nodeCmd = `node ${outputFile}`
  try {
    execSync(nodeCmd, { stdio: 'inherit' })
  } catch (error) {
    console.error('Exit code:', error?.status ?? '?', 'for', { nodeCmd })
    process.exit(error?.status ?? 1)
  }
  console.log('Quit happily:', { nodeCmd })
  process.exit(0)
  // execSync(`node --enable-source-maps --prof ${outputFile}`, { stdio: 'inherit' })
  // $ node --prof-process isolate-0x58a58b0-184630-v8.log > profile.txt
}

void main()
