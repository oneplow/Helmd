import { Router } from 'express'
import { getDocker } from '../docker.js'

const router = Router()

/**
 * GET /api/images
 * List all images
 */
router.get('/', async (req, res) => {
    try {
        const docker = getDocker()
        const images = await docker.listImages()
        const result = images.map(img => ({
            id: img.Id.replace('sha256:', '').slice(0, 12),
            repoTags: img.RepoTags || ['<none>:<none>'],
            size: img.Size,
            created: img.Created,
        }))
        res.json(result)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * GET /api/images/:id/inspect
 * Inspect an image
 */
router.get('/:id/inspect', async (req, res) => {
    try {
        const docker = getDocker()
        const image = docker.getImage(req.params.id)
        const inspectData = await image.inspect()
        res.json(inspectData)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * POST /api/images/pull
 * Pull an image
 */
router.post('/pull', async (req, res) => {
    const { repoTag } = req.body
    if (!repoTag) return res.status(400).json({ error: 'repoTag is required' })

    try {
        const docker = getDocker()

        // Use SSE to stream progress
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.flushHeaders()

        docker.pull(repoTag, (err, stream) => {
            if (err) {
                res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
                return res.end()
            }

            docker.modem.followProgress(stream, (err, output) => {
                if (err) {
                    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
                } else {
                    res.write(`data: ${JSON.stringify({ status: 'complete' })}\n\n`)
                }
                res.end()
            }, (event) => {
                res.write(`data: ${JSON.stringify(event)}\n\n`)
            })
        })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * DELETE /api/images/:name
 * Remove an image
 */
router.delete('/:name', async (req, res) => {
    try {
        const docker = getDocker()
        const image = docker.getImage(req.params.name)
        await image.remove({ force: true })
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

export default router
