import { getWhitelist } from './config.js'

/**
 * Whitelist Middleware
 * Restricts access to a list of allowed IPs.
 * If the whitelist is empty, all IPs are allowed.
 */
export function whitelistMiddleware(req, res, next) {
    const whitelist = getWhitelist()

    // If whitelist is empty, everyone is allowed
    if (!whitelist || whitelist.length === 0) {
        return next()
    }

    // Get client IP, accounting for proxies
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || req.socket.remoteAddress

    // Check if IP or any of its parts is whitelisted
    // Supports exact IP match and basic wildcard e.g. 192.168.1.*
    const isAllowed = whitelist.some(allowed => {
        const pattern = allowed.trim()
        if (pattern === clientIp) return true

        if (pattern.endsWith('*')) {
            const prefix = pattern.slice(0, -1)
            return clientIp.startsWith(prefix)
        }

        return false
    })

    if (!isAllowed) {
        console.warn(`[helmd] Blocked request from unauthorized IP: ${clientIp}`)
        return res.status(403).json({
            error: 'Forbidden',
            message: `Your IP (${clientIp}) is not whitelisted on this Helmd host.`
        })
    }

    next()
}
