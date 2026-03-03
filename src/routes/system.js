import { Router } from 'express'
import { getDocker } from '../docker.js'
import { regenerateApiKey, getWhitelist, updateWhitelist } from '../config.js'
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'

const router = Router()

async function getSystemStatsInfo() {
    const docker = getDocker()
    const info = await docker.info()
    const images = await docker.listImages()

    // Get Host OS Stats
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = totalMem - freeMem

    // Calculate actual CPU usage using delta
    const cpuUsedPercent = getCpuUsage()
    const loadAvg = os.loadavg()[0]
    const ncpu = os.cpus().length || 1

    // Container memory stats
    let containersMemUsedTotal = 0
    try {
        const runningContainers = await docker.listContainers({ filters: { status: ['running'] } })
        const statsPromises = runningContainers.slice(0, 5).map(async (c) => {
            try {
                const container = docker.getContainer(c.Id)
                const stats = await Promise.race([
                    container.stats({ stream: false }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 800))
                ])
                return { mem: stats.memory_stats?.usage || 0 }
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
            resourceLimitsSet: 0,
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

    return {
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
    }
}

/**
 * POST /api/system/reset-key
 */
router.post('/reset-key', async (req, res) => {
    try {
        console.log('[helmd] API Key reset requested via API')
        regenerateApiKey()
        res.json({ success: true, message: 'API key has been successfully reset and invalidated.' })
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset API key', detail: err.message })
    }
})

/**
 * GET /api/system/whitelist
 */
router.get('/whitelist', (req, res) => {
    res.json(getWhitelist())
})

/**
 * PATCH /api/system/whitelist
 */
router.patch('/whitelist', (req, res) => {
    try {
        const { whitelist } = req.body
        if (!Array.isArray(whitelist)) return res.status(400).json({ error: 'Whitelist must be an array' })
        const updated = updateWhitelist(whitelist)
        res.json({ success: true, whitelist: updated })
    } catch (err) {
        res.status(500).json({ error: 'Failed to update whitelist', detail: err.message })
    }
})

/**
 * GET /api/system/info
 * Standard polling endpoint (kept for compatibility)
 */
router.get('/info', async (req, res) => {
    try {
        const stats = await getSystemStatsInfo()
        res.json(stats)
    } catch (err) {
        res.status(500).json({ error: 'Failed to get system info', detail: err.message })
    }
})

/**
 * GET /api/system/stats/stream
 * Real-time SSE stream for system stats
 */
router.get('/stats/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    console.log('[helmd] New SSE stats stream client connected')

    const sendStats = async () => {
        try {
            const stats = await getSystemStatsInfo()
            res.write(`data: ${JSON.stringify(stats)}\n\n`)
        } catch (err) {
            console.error('[helmd] SSE stats error:', err.message)
        }
    }

    // Send immediately then every 3 seconds
    sendStats()
    const interval = setInterval(sendStats, 3000)

    req.on('close', () => {
        console.log('[helmd] SSE stats stream client disconnected')
        clearInterval(interval)
    })
})

/**
 * GET /api/system/events
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
        req.on('close', () => stream.destroy())
    } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
        res.end()
    }
})

export default router
