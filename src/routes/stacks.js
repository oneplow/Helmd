import { Router } from 'express'
import { getDocker } from '../docker.js'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const execFileAsync = promisify(execFile)

const router = Router()

/**
 * GET /api/stacks
 * List all compose stacks (grouped by com.docker.compose.project label)
 */
router.get('/', async (req, res) => {
    try {
        const docker = getDocker()
        const containers = await docker.listContainers({ all: true })

        const stackMap = {}

        containers.forEach(c => {
            const projectName = c.Labels?.['com.docker.compose.project']
            if (!projectName) return

            if (!stackMap[projectName]) {
                stackMap[projectName] = {
                    name: projectName,
                    containers: [],
                    runningCount: 0,
                    stoppedCount: 0,
                    services: new Set(),
                    created: null
                }
            }

            const serviceName = c.Labels?.['com.docker.compose.service'] || c.Names?.[0]?.replace('/', '')
            const isRunning = c.State === 'running'

            stackMap[projectName].containers.push({
                id: c.Id,
                name: c.Names?.[0]?.replace('/', '') || c.Id.substring(0, 12),
                image: c.Image,
                state: c.State,
                status: c.Status,
                service: serviceName,
            })

            if (isRunning) stackMap[projectName].runningCount++
            else stackMap[projectName].stoppedCount++

            stackMap[projectName].services.add(serviceName)

            if (!stackMap[projectName].created || c.Created < stackMap[projectName].created) {
                stackMap[projectName].created = c.Created
            }
        })

        const stacks = Object.values(stackMap).map(s => ({
            ...s,
            services: [...s.services],
            totalCount: s.containers.length,
            status: s.runningCount === s.containers.length ? 'running'
                : s.runningCount === 0 ? 'stopped'
                    : 'partial'
        }))

        stacks.sort((a, b) => {
            if (a.status === 'running' && b.status !== 'running') return -1
            if (a.status !== 'running' && b.status === 'running') return 1
            return a.name.localeCompare(b.name)
        })

        res.json({ stacks })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * POST /api/stacks
 * Perform stack actions: start, stop, restart, remove
 */
router.post('/', async (req, res) => {
    const { action, stackName } = req.body

    if (!stackName) return res.status(400).json({ error: 'Stack name is required' })

    try {
        const docker = getDocker()
        const containers = await docker.listContainers({ all: true })

        const stackContainers = containers.filter(
            c => c.Labels?.['com.docker.compose.project'] === stackName
        )

        if (stackContainers.length === 0) {
            return res.status(404).json({ error: 'Stack not found' })
        }

        const results = []

        for (const c of stackContainers) {
            const container = docker.getContainer(c.Id)
            const name = c.Names?.[0]?.replace('/', '') || c.Id.substring(0, 12)
            try {
                if (action === 'stop') {
                    if (c.State === 'running') {
                        await container.stop()
                        results.push({ name, status: 'stopped' })
                    } else {
                        results.push({ name, status: 'already stopped' })
                    }
                } else if (action === 'start') {
                    if (c.State !== 'running') {
                        await container.start()
                        results.push({ name, status: 'started' })
                    } else {
                        results.push({ name, status: 'already running' })
                    }
                } else if (action === 'restart') {
                    await container.restart()
                    results.push({ name, status: 'restarted' })
                } else if (action === 'remove') {
                    if (c.State === 'running') await container.stop()
                    await container.remove({ force: true })
                    results.push({ name, status: 'removed' })
                } else {
                    return res.status(400).json({ error: 'Invalid action' })
                }
            } catch (err) {
                results.push({ name, status: 'error', error: err.message })
            }
        }

        res.json({ success: true, results })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * POST /api/compose
 * Deploy or teardown a compose stack from YAML
 */
router.post('/compose', async (req, res) => {
    const { composeYaml, action = 'up', projectName = 'helm-stack' } = req.body

    if (!composeYaml) {
        return res.status(400).json({ error: 'Missing composeYaml' })
    }

    const cleanProjectName = (projectName || 'helm-stack').replace(/[^a-zA-Z0-9_-]/g, '')
    if (!cleanProjectName) {
        return res.status(400).json({ error: 'Invalid project name' })
    }

    const tempDir = os.tmpdir()
    const filePath = path.join(tempDir, `docker-compose-${cleanProjectName}-${Date.now()}.yml`)

    try {
        await fs.writeFile(filePath, composeYaml, 'utf8')

        let args = []
        if (action === 'up') {
            args = ['compose', '-f', filePath, '-p', cleanProjectName, 'up', '-d', '--pull', 'missing']
        } else if (action === 'down') {
            args = ['compose', '-f', filePath, '-p', cleanProjectName, 'down']
        } else {
            await fs.unlink(filePath).catch(() => { })
            return res.status(400).json({ error: `Unknown action: ${action}` })
        }

        const { stdout, stderr } = await execFileAsync('docker', args, { timeout: 120000 })

        // Cleanup temp file after down
        if (action === 'down') {
            await fs.unlink(filePath).catch(() => { })
        }

        res.json({ success: true, logs: stdout || stderr || 'Done' })
    } catch (err) {
        await fs.unlink(filePath).catch(() => { })
        res.status(500).json({ error: err.stderr || err.message || 'Compose execution failed' })
    }
})

export default router
