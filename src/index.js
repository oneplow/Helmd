import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'

import { initConfig, verifyApiKey } from './config.js'
import { authMiddleware } from './auth.js'

// Routes
import pingRouter from './routes/ping.js'
import systemRouter from './routes/system.js'
import containersRouter from './routes/containers.js'
import imagesRouter from './routes/images.js'
import volumesRouter from './routes/volumes.js'
import networksRouter from './routes/networks.js'
import stacksRouter from './routes/stacks.js'
import { setupTerminalWs } from './routes/terminal.js'

// Initialize config (generates API key on first run)
const config = initConfig()

const app = express()
const PORT = parseInt(process.env.HELMD_PORT) || 9117

// Security middleware
app.use(helmet())
app.use(cors())
app.use(express.json({ limit: '10mb' }))

// Rate limiting: 200 requests per minute per IP
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' }
})
app.use(limiter)

// Auth middleware on all /api routes
app.use('/api', authMiddleware)

// Mount routes
app.use('/api', pingRouter)
app.use('/api/system', systemRouter)
app.use('/api/containers', containersRouter)
app.use('/api/images', imagesRouter)
app.use('/api/volumes', volumesRouter)
app.use('/api/networks', networksRouter)
app.use('/api/stacks', stacksRouter)

// Health check (no auth required)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '1.0.0' })
})

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' })
})

// Error handler
app.use((err, req, res, next) => {
    console.error('[helmd] Error:', err.message)
    res.status(500).json({ error: 'Internal server error' })
})

// Create HTTP server
const server = createServer(app)

// WebSocket server for terminal
const wss = new WebSocketServer({
    server,
    path: '/ws/terminal',
    verifyClient: (info, callback) => {
        // Verify API key from query string for WebSocket connections
        const url = new URL(info.req.url, `http://${info.req.headers.host}`)
        const apiKey = url.searchParams.get('apiKey')

        if (!apiKey || !verifyApiKey(apiKey)) {
            callback(false, 401, 'Unauthorized')
            return
        }

        callback(true)
    }
})

setupTerminalWs(wss)

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[helmd] Daemon running on port ${PORT}`)
    console.log(`[helmd] Endpoints: http://0.0.0.0:${PORT}/api/...`)
    console.log(`[helmd] Terminal WS: ws://0.0.0.0:${PORT}/ws/terminal`)
    console.log(`[helmd] Health: http://0.0.0.0:${PORT}/health`)
})
