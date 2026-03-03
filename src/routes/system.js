import { Router } from 'express'
import { getDocker } from '../docker.js'
import { regenerateApiKey } from '../config.js'
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'

const router = Router()

let lastCpuInfo = null

function getCpuUsage() {
    const cpus = os.cpus()
    let user = 0, nice = 0, sys = 0, idle = 0, irq = 0
    for (const cpu of cpus) {
        user += cpu.times.user
        nice += cpu.times.nice
        sys += cpu.times.sys
        idle += cpu.times.idle
        irq += cpu.times.irq
    }
    const total = user + nice + sys + idle + irq
    if (!lastCpuInfo) {
        lastCpuInfo = { user, nice, sys, idle, irq, total, ts: Date.now() }
        return (os.loadavg()[0] / (cpus.length || 1)) * 100 // Fallback to load on first call
    }

    const diffTotal = total - lastCpuInfo.total
    const diffIdle = idle - lastCpuInfo.idle

    lastCpuInfo = { user, nice, sys, idle, irq, total, ts: Date.now() }

    if (diffTotal <= 0) return 0
    return Math.min(100, Math.max(0, ((diffTotal - diffIdle) / diffTotal) * 100))
}

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

        // Get Host OS Stats (more reliable than summing container stats)
        const totalMem = os.totalmem()
        const freeMem = os.freemem()
        const usedMem = totalMem - freeMem

        // Calculate actual CPU usage using delta
        const cpuUsedPercent = getCpuUsage()
        const loadAvg = os.loadavg()[0]
        const ncpu = os.cpus().length || 1

        // Still calculate container stats if wanted, but host stats are primary
        let containersMemUsedTotal = 0
        let containersCpuUsedTotal = 0

        try {
            const runningContainers = await docker.listContainers({ filters: { status: ['running'] } })
            const statsPromises = runningContainers.slice(0, 10).map(async (c) => {
                try {
                    const container = docker.getContainer(c.Id)
                    const stats = await Promise.race([
                        container.stats({ stream: false }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000))
                    ])
                    const mem = stats.memory_stats?.usage || 0
                    return { mem }
                } catch { return { mem: 0 } }
            })
            const resultsData = await Promise.all(statsPromises)
            containersMemUsedTotal = resultsData.reduce((a, b) => a + b.mem, 0)
        } catch { }

        // Docker policies
        let policies = {}
        try {
            const danglingImages = images.filter(img => img.RepoTags?.includes('<none>:<none>')).length
            const officialImagesCount = images.filter(img => img.RepoTags?.some(tag => !tag.includes('/'))).length

            policies = {
                healthyImagesCount: images.length - danglingImages,
                resourceLimitsSet: 0, // Simplified to avoid slow inspects
                officialBaseImages: officialImagesCount,
            }
        } catch { }

        // Host Storage calculation
        let storage = { total: 0, used: 0, usedPercent: 0 }
        try {
            if (fs.statfsSync) {
                const stats = fs.statfsSync('/')
                storage.total = stats.bsize * stats.blocks
                storage.used = stats.bsize * (stats.blocks - stats.bfree)
                storage.usedPercent = (storage.used / storage.total) * 100
            } else {
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
        } catch (err) { }

        res.json({
            containers: {
                total: info.Containers,
                running: info.ContainersRunning,
                stopped: info.ContainersStopped,
                paused: info.ContainersPaused,
            },
            images: { total: images.length },
            memory: {
                total: totalMem,
                used: usedMem,
                containersUsed: containersMemUsedTotal,
            },
            cpu: {
                usedPercent: cpuUsedPercent,
                loadAvg,
            },
            storage,
            ncpu: ncpu,
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
