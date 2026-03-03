import { Router } from 'express'
import { getDocker } from '../docker.js'

const router = Router()

/**
 * GET /api/networks
 * List all networks
 */
router.get('/', async (req, res) => {
    try {
        const docker = getDocker()
        const networks = await docker.listNetworks()

        const result = networks.map(n => {
            let subnet = ''
            if (n.IPAM && n.IPAM.Config && n.IPAM.Config.length > 0) {
                subnet = n.IPAM.Config[0].Subnet || ''
            }

            return {
                id: n.Id.slice(0, 12),
                name: n.Name,
                driver: n.Driver,
                scope: n.Scope,
                subnet: subnet || '—',
                containers: Object.keys(n.Containers || {}).length
            }
        })

        res.json(result)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * POST /api/networks
 * Create a network
 */
router.post('/', async (req, res) => {
    try {
        const docker = getDocker()
        const { name } = req.body
        if (!name) return res.status(400).json({ error: 'Network name is required' })
        const network = await docker.createNetwork({ Name: name })
        res.json(network)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * DELETE /api/networks/:id
 * Remove a network
 */
router.delete('/:id', async (req, res) => {
    try {
        const docker = getDocker()
        const network = docker.getNetwork(req.params.id)
        await network.remove()
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

export default router
