import { Router } from 'express'
import { getDocker } from '../docker.js'

const router = Router()

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 B'
    const k = 1024
    const dm = decimals < 0 ? 0 : decimals
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

/**
 * GET /api/volumes
 * List all volumes with usage info
 */
router.get('/', async (req, res) => {
    try {
        const docker = getDocker()
        const dfInfo = await docker.df()
        const volumesUsage = dfInfo.Volumes || []

        const containers = await docker.listContainers({ all: true })
        const volumeUsageByContainer = {}

        for (const container of containers) {
            for (const mount of container.Mounts || []) {
                if (mount.Type === 'volume' && mount.Name) {
                    if (!volumeUsageByContainer[mount.Name]) volumeUsageByContainer[mount.Name] = []
                    volumeUsageByContainer[mount.Name].push(container.Names[0]?.replace('/', ''))
                }
            }
        }

        const result = volumesUsage.map(v => {
            const sizeBytes = v.UsageData?.Size || 0
            return {
                name: v.Name,
                driver: v.Driver,
                mountpoint: v.Mountpoint,
                created: v.CreatedAt ? new Date(v.CreatedAt).toISOString().split('T')[0] : 'Unknown',
                size: formatBytes(sizeBytes),
                containers: volumeUsageByContainer[v.Name] || []
            }
        })

        res.json(result)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * POST /api/volumes
 * Create a volume
 */
router.post('/', async (req, res) => {
    try {
        const docker = getDocker()
        const { name } = req.body
        const options = name ? { Name: name } : {}
        const volume = await docker.createVolume(options)
        res.json(volume)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * DELETE /api/volumes/:name
 * Remove a volume
 */
router.delete('/:name', async (req, res) => {
    try {
        const docker = getDocker()
        const volume = docker.getVolume(req.params.name)
        await volume.remove()
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

export default router
