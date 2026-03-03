import { Router } from 'express'
import { getDocker } from '../docker.js'

const router = Router()

/**
 * GET /api/ping
 * Quick connection test — returns Docker version info
 * Used by Helm's "Test Connection" button
 */
router.get('/ping', async (req, res) => {
    try {
        const docker = getDocker()
        const version = await docker.version()
        res.json({
            status: 'ok',
            helmd: '1.0.0',
            docker: {
                version: version.Version,
                apiVersion: version.ApiVersion,
                os: version.Os,
                arch: version.Arch,
            }
        })
    } catch (err) {
        res.status(503).json({
            status: 'error',
            message: 'Cannot connect to Docker daemon',
            detail: err.message
        })
    }
})

export default router
