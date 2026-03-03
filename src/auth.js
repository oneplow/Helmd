import { verifyApiKey } from './config.js'

/**
 * Express middleware — verify Bearer token against stored API key hash
 */
export function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Missing or invalid Authorization header. Use: Bearer <API_KEY>'
        })
    }

    const token = authHeader.slice(7) // Remove "Bearer "

    if (!verifyApiKey(token)) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Invalid API key'
        })
    }

    next()
}
