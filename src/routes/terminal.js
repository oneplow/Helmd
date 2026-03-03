import { getDocker } from '../docker.js'

const terminalSessions = new Map()

/**
 * Setup WebSocket terminal endpoint
 * Called from index.js with the WebSocket server instance
 */
export function setupTerminalWs(wss) {
    wss.on('connection', (ws, req) => {
        const url = new URL(req.url, `http://${req.headers.host}`)
        const containerId = url.searchParams.get('id')
        const sessionId = url.searchParams.get('sessionId')

        if (!containerId || !sessionId) {
            ws.send(JSON.stringify({ error: 'Missing id or sessionId' }))
            ws.close()
            return
        }

        const docker = getDocker()
        const container = docker.getContainer(containerId)

        container.exec({
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: true,
            Cmd: ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi']
        }).then(exec => {
            return exec.start({ stdin: true, hijack: true })
        }).then(execStream => {
            terminalSessions.set(sessionId, { stream: execStream })

            // Docker → WebSocket
            execStream.on('data', (data) => {
                if (ws.readyState === ws.OPEN) {
                    let text = data.toString('utf-8')

                    // Intercept errors for distroless containers
                    if (text.includes('no such file or directory') && text.includes('/bin/sh')) {
                        text += '\r\n\x1b[33m[helmd] This container is a minimal/distroless image.\r\nTerminal access is not available.\x1b[0m\r\n'
                    }

                    ws.send(text)
                }
            })

            execStream.on('end', () => {
                terminalSessions.delete(sessionId)
                if (ws.readyState === ws.OPEN) ws.close()
            })

            // WebSocket → Docker
            ws.on('message', (data) => {
                if (execStream.writable) {
                    execStream.write(data.toString())
                }
            })

            ws.on('close', () => {
                terminalSessions.delete(sessionId)
                try { execStream.end() } catch { }
            })

        }).catch(err => {
            if (ws.readyState === ws.OPEN) {
                ws.send(`\r\n\x1b[31mFailed to start terminal: ${err.message}\x1b[0m\r\n`)
                ws.close()
            }
        })
    })
}
