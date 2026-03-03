import { regenerateApiKey, initConfig } from './config.js'

const args = process.argv.slice(2)

if (args.includes('reset') || args.includes('reset-key')) {
    console.log('[helmd] Regenerating API key...')
    regenerateApiKey()
} else {
    console.log('[helmd] Running initial setup...')
    initConfig()
    console.log('[helmd] Setup complete.')
}
