import { Router } from 'express'
import { regenerateApiKey, getWhitelist, updateWhitelist } from '../config.js'
import { getDocker } from '../docker.js'
import { getCachedStats, subscribe } from '../smartCache.js'

const router = Router()

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
 * One-shot read from cache (no polling, instant response)
 */
router.get('/info', (req, res) => {
    try {
        res.json(getCachedStats())
    } catch (err) {
        res.status(500).json({ error: 'Failed to get system info', detail: err.message })
    }
})

/**
 * GET /api/system/stats/stream
 * SSE stream — subscribes to smartCache updates instead of setInterval
 */
router.get('/stats/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    console.log('[helmd] New SSE stats stream client connected')

    // Send current cache immediately
    const current = getCachedStats()
    res.write(`data: ${JSON.stringify(current)}\n\n`)

    // Subscribe to future updates
    const unsubscribe = subscribe((stats) => {
        try {
            res.write(`data: ${JSON.stringify(stats)}\n\n`)
        } catch {
            // Client disconnected
            unsubscribe()
        }
    })

    req.on('close', () => {
        console.log('[helmd] SSE stats stream client disconnected')
        unsubscribe()
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
