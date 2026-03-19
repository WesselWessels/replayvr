import basicSsl from '@vitejs/plugin-basic-ssl'
import { execFile } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

export default {
  plugins: [
    basicSsl(),
    {
      name: 'parse-replay',
      configureServer(server) {
        server.middlewares.use('/parse-replay', (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }

          const chunks = []
          req.on('data', chunk => chunks.push(chunk))
          req.on('end', () => {
            const body = Buffer.concat(chunks)
            const tmpFile = join(tmpdir(), `rl_replay_${Date.now()}.replay`)
            const parserBin = resolve('./parser/target/release/rl-parser')

            try {
              writeFileSync(tmpFile, body)
            } catch (e) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: 'Could not write temp file: ' + e.message }))
              return
            }

            execFile(parserBin, [tmpFile], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
              try { unlinkSync(tmpFile) } catch {}
              if (err) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: stderr || err.message }))
                return
              }
              res.setHeader('Content-Type', 'application/json')
              res.end(stdout)
            })
          })
        })
      },
    },
  ],
  server: {
    https: true,
    host: true,
  },
}
