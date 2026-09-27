#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { REPOSITORY_ROOT } from '../../controller/src/config.mjs'
import { CoreEngine } from './core-engine.mjs'
import { createServer } from './http-api.mjs'

const repositoryRoot = resolve(process.env.HARNESS_REPOSITORY_ROOT ?? REPOSITORY_ROOT)
const engine = new CoreEngine({ repositoryRoot })
let version = '0.1.0'
try { version = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8')).version } catch {}

const host = process.env.HARNESS_SERVER_HOST ?? '127.0.0.1'
const port = Number(process.env.HARNESS_SERVER_PORT ?? '8787')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HARNESS_SERVER_PORT 必须是 1..65535')

const server = createServer({ engine, versionInfo: { version } })
server.listen(port, host, () => {
  process.stdout.write(`HarnessEvoGym Server API listening on http://${host}:${port}\n`)
})
