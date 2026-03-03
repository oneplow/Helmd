import { Router } from 'express'
import { getDocker } from '../docker.js'
import { regenerateApiKey } from '../config.js'
import { execSync } from 'child_process'
import fs from 'fs'

const router = Router()

/**
 * POST /api/system/reset-key
 * Resets the API key for this agent.
 * This is used when a host is deleted from Helm.
 */
router.post('/reset-key', async (req, res) => {
    try {
        console.log('[helmd] API Key reset requested via API')
        // We don't return the new key in the response for security.
        // The user would need to check the logs or have CLI access.
        // But since the host is being deleted from Helm, it's safer to just invalidate it.
        regenerateApiKey()
        res.json({ success: true, message: 'API key has been successfully reset and invalidated.' })
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset API key', detail: err.message })
    }
})

/**
 * GET /api/system/info
 * Returns system info: containers, images, memory, CPU, docker version
 */
router.get('/info', async (req, res) => {
    try {
        const docker = getDocker()
        const info = await docker.info()
        const images = await docker.listImages()

        // Calculate actual memory and CPU used by running containers
        let containersMemUsed = 0
        let containersCpuUsed = 0

        try {
            const runningContainers = await docker.listContainers({ filters: { status: ['running'] } })
            const statsPromises = runningContainers.map(async (c) => {
                try {
                    const container = docker.getContainer(c.Id)
                    const stats = await container.stats({ stream: false })

                    const mem = stats.memory_stats?.usage || 0

                    let cpuPct = 0
                    try {
                        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage
                        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage
                        if (systemDelta > 0 && cpuDelta > 0) {
                            const cpus = stats.cpu_stats.online_cpus || 1
                            cpuPct = (cpuDelta / systemDelta) * cpus * 100
                        }
                    } catch { }

                    return { mem, cpu: cpuPct }
                } catch { return { mem: 0, cpu: 0 } }
            })

            const results = await Promise.all(statsPromises)
            containersMemUsed = results.reduce((a, b) => a + b.mem, 0)
            containersCpuUsed = results.reduce((a, b) => a + b.cpu, 0)
        } catch { }

        // Docker policies
        let policies = {}
        try {
            const containers = await docker.listContainers({ all: true })
            let resourceLimitsSet = 0

            for (const container of containers) {
                const cInfo = await docker.getContainer(container.Id).inspect()
                if (cInfo.HostConfig?.Memory > 0 || cInfo.HostConfig?.CpuQuota > 0 || cInfo.HostConfig?.CpuShares > 0) {
                    resourceLimitsSet++
                }
            }

            const danglingImages = images.filter(img => img.RepoTags?.includes('<none>:<none>')).length
            const officialImagesCount = images.filter(img => img.RepoTags?.some(tag => !tag.includes('/'))).length

            policies = {
                healthyImagesCount: images.length - danglingImages,
                resourceLimitsSet,
                officialBaseImages: officialImagesCount,
            }
        } catch { }

        // Host Storage calculation
        let storage = { total: 0, used: 0, usedPercent: 0 }
        try {
            // Try node's built-in statfs first (available in newer node versions)
            if (fs.statfsSync) {
                const stats = fs.statfsSync('/')
                storage.total = stats.bsize * stats.blocks
                storage.used = stats.bsize * (stats.blocks - stats.bfree)
                storage.usedPercent = (storage.used / storage.total) * 100
            } else {
                // Fallback to df command
                const dfOutput = execSync('df -k / | tail -1').toString().trim()
                const parts = dfOutput.split(/\s+/)
                if (parts.length >= 5) {
                    const totalKB = parseInt(parts[1], 10)
                    const usedKB = parseInt(parts[2], 10)
                    storage.total = totalKB * 1024
                    storage.used = usedKB * 1024
                    storage.usedPercent = (usedKB / totalKB) * 100
                }
            }
        } catch (err) {
            console.warn('[helmd] Failed to get host storage info:', err.message)
        }

        res.json({
            containers: {
                total: info.Containers,
                running: info.ContainersRunning,
                stopped: info.ContainersStopped,
                paused: info.ContainersPaused,
            },
            images: { total: images.length },
            memory: {
                total: info.MemTotal,
                used: containersMemUsed,
            },
            cpu: {
                usedPercent: containersCpuUsed,
            },
            storage,
            ncpu: info.NCPU,
            serverVersion: info.ServerVersion,
            operatingSystem: info.OperatingSystem,
            architecture: info.Architecture,
            policies,
        })
    } catch (err) {
        res.status(500).json({ error: 'Failed to get system info', detail: err.message })
    }
})

/**
 * GET /api/system/events
 * Server-Sent Events stream of Docker events
 */
router.get('/events', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    try {
        const docker = getDocker()
        const stream = await docker.getEvents()

        stream.on('data', (chunk) => {
            try {
                const event = JSON.parse(chunk.toString())
                res.write(`data: ${JSON.stringify(event)}\n\n`)
            } catch { }
        })

        stream.on('error', () => res.end())

        req.on('close', () => {
            stream.destroy()
        })
    } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
        res.end()
    }
})

export default router
