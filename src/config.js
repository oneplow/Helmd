import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'

const DATA_DIR = process.env.HELMD_DATA_DIR || '/data'
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')

function hashKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex')
}

function readConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
        }
    } catch (e) {
        console.error('[helmd] Failed to read config:', e.message)
    }
    return null
}

function writeConfig(config) {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true })
    }

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 })
}

/**
 * Initialize config — generate API key on first run.
 * Returns the config object. The raw API key is only printed once.
 */
export function initConfig() {
    let config = readConfig()

    if (config && config.apiKeyHash) {
        console.log('[helmd] Config loaded. API key is already set.')
        return config
    }

    // Generate new API key with "hd_" prefix for easy identification
    const rawKey = `hd_${uuidv4().replace(/-/g, '')}`
    const keyHash = hashKey(rawKey)

    config = {
        apiKeyHash: keyHash,
        createdAt: new Date().toISOString(),
    }

    writeConfig(config)

    // Print the key ONCE — user must copy it now
    console.log('')
    console.log('╔══════════════════════════════════════════════════════════╗')
    console.log('║                   HELMD - FIRST RUN                     ║')
    console.log('╠══════════════════════════════════════════════════════════╣')
    console.log('║                                                        ║')
    console.log(`║  Your API Key: ${rawKey}  ║`)
    console.log('║                                                        ║')
    console.log('║  ⚠  SAVE THIS KEY NOW — it will NOT be shown again!    ║')
    console.log('║  Copy it to your Helm dashboard → Settings → Add Host  ║')
    console.log('║                                                        ║')
    console.log('╚══════════════════════════════════════════════════════════╝')
    console.log('')

    return config
}

/**
 * Verify an API key against stored hash
 */
export function verifyApiKey(key) {
    const config = readConfig()
    if (!config || !config.apiKeyHash) return false
    return hashKey(key) === config.apiKeyHash
}

/**
 * Regenerate API key — used by CLI: node src/setup.js reset
 */
export function regenerateApiKey() {
    const rawKey = `hd_${uuidv4().replace(/-/g, '')}`
    const keyHash = hashKey(rawKey)

    const config = readConfig() || {}
    config.apiKeyHash = keyHash
    config.updatedAt = new Date().toISOString()

    writeConfig(config)

    console.log('')
    console.log('[helmd] API Key has been regenerated!')
    console.log(`[helmd] New API Key: ${rawKey}`)
    console.log('[helmd] Save this key — it will NOT be shown again.')
    console.log('')

    return rawKey
}
