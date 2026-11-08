// Start the dependency-free HTTP fixture server for out-of-process harnesses
// (the sandboxed Python e2e driver cannot import this module directly).
//
// Prints one JSON line: {"url":"http://127.0.0.1:PORT","port":PORT}
// then stays alive until stdin closes or SIGTERM.
import { startFixtureServer } from './fixture-server.mjs'

const fixture = await startFixtureServer({ host: '127.0.0.1', port: 0 })
process.stdout.write(`${JSON.stringify({ url: fixture.url, port: fixture.port })}\n`)
process.stdout.write('')

async function shutdown() {
  try {
    await fixture.close()
  } finally {
    process.exit(0)
  }
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.stdin.resume()
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
