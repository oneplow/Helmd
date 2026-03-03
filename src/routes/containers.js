import { Router } from 'express'
import { getDocker } from '../docker.js'

const router = Router()

/**
 * GET /api/containers
 * List all containers
 */
router.get('/', async (req, res) => {
    try {
        const docker = getDocker()
        const containers = await docker.listContainers({ all: true })
        const result = containers.map(c => ({
            id: c.Id.slice(0, 12),
            name: c.Names[0]?.replace('/', '') || c.Id.slice(0, 12),
            image: c.Image,
            status: c.State,
            state: c.Status,
            ports: c.Ports?.map(p => p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}` : null).filter(Boolean),
            created: c.Created,
        }))
        res.json(result)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * GET /api/containers/:id
 * Inspect a container
 */
router.get('/:id', async (req, res) => {
    try {
        const docker = getDocker()
        const container = docker.getContainer(req.params.id)
        const inspectData = await container.inspect()
        res.json(inspectData)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * GET /api/containers/:id/stats
 * One-shot stats for a container
 */
router.get('/:id/stats', async (req, res) => {
    try {
        const docker = getDocker()
        const container = docker.getContainer(req.params.id)
        const stats = await container.stats({ stream: false })

        if (!stats) return res.status(500).json({ error: 'Failed to fetch stats' })

        // Safe CPU Calculation
        let cpuPercent = 0
        try {
            const cpuUsage = stats.cpu_stats?.cpu_usage?.total_usage || 0
            const preCpuUsage = stats.precpu_stats?.cpu_usage?.total_usage || 0
            const systemUsage = stats.cpu_stats?.system_cpu_usage || 0
            const preSystemUsage = stats.precpu_stats?.system_cpu_usage || 0
            const numCpus = stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1

            const cpuDelta = cpuUsage - preCpuUsage
            const systemDelta = systemUsage - preSystemUsage

            if (systemDelta > 0 && cpuDelta > 0) {
                cpuPercent = (cpuDelta / systemDelta) * numCpus * 100
            }
        } catch (e) {
            console.error('[helmd] CPU Stats calculation error:', e.message)
        }

        // Safe Memory Calculation
        let memUsage = 0
        let memLimit = 0
        let memPercent = 0
        try {
            memUsage = stats.memory_stats?.usage || 0
            memLimit = stats.memory_stats?.limit || 1
            memPercent = (memUsage / memLimit) * 100
        } catch (e) {
            console.error('[helmd] Memory Stats calculation error:', e.message)
        }

        // Safe Network Calculation
        let netRx = 0, netTx = 0
        try {
            if (stats.networks) {
                for (const iface of Object.values(stats.networks)) {
                    netRx += iface.rx_bytes || 0
                    netTx += iface.tx_bytes || 0
                }
            }
        } catch (e) {
            console.error('[helmd] Network Stats calculation error:', e.message)
        }

        res.json({
            cpu: Math.round(cpuPercent * 100) / 100,
            memUsage,
            memLimit,
            memPercent: Math.round(memPercent * 100) / 100,
            netRx,
            netTx,
            timestamp: Date.now(),
        })
    } catch (err) {
        console.error('[helmd] Stats route error:', err.message)
        res.status(500).json({ error: err.message })
    }
})

/**
 * GET /api/containers/:id/logs
 * Fetch container logs (last 500 lines)
 */
router.get('/:id/logs', async (req, res) => {
    try {
        const docker = getDocker()
        const container = docker.getContainer(req.params.id)
        const tail = parseInt(req.query.tail) || 500

        const logs = await container.logs({
            stdout: true,
            stderr: true,
            timestamps: true,
            tail
        })

        const cleanLogs = logs.toString('utf8')
            .split('\n')
            .map(line => line.replace(/^[\u0000-\u0009\u000B-\u001F\u007F]+/, ''))
            .filter(line => line.trim().length > 0)

        res.json({ logs: cleanLogs })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * POST /api/containers
 * Create container or perform container actions (start, stop, restart, remove)
 */
router.post('/', async (req, res) => {
    const { action, containerId, image, name, ports, env, network, restartPolicy, volumes, command } = req.body

    try {
        const docker = getDocker()

        if (action === 'create') {
            // Pull image first
            await new Promise((resolve, reject) => {
                docker.pull(image, (err, stream) => {
                    if (err) return reject(err)
                    docker.modem.followProgress(stream, (err) => {
                        if (err) return reject(err)
                        resolve()
                    })
                })
            })

            // Setup port bindings
            const ExposedPorts = {}
            const PortBindings = {}
            if (ports) {
                const portMappings = ports.split(',').map(p => p.trim()).filter(Boolean)
                for (const mapping of portMappings) {
                    const [hostPort, containerPort] = mapping.split(':')
                    if (hostPort && containerPort) {
                        ExposedPorts[`${containerPort}/tcp`] = {}
                        PortBindings[`${containerPort}/tcp`] = [{ HostPort: hostPort }]
                    }
                }
            }

            // Setup Environment Variables
            let Env = []
            if (env) {
                Env = env.split('\n')
                    .map(e => e.trim())
                    .filter(e => e.includes('='))
            }

            // Setup Volume Binds
            let Binds = []
            if (volumes && Array.isArray(volumes)) {
                Binds = volumes
            }

            // Setup Command
            let Cmd = undefined
            if (command) {
                Cmd = command.split(' ').filter(Boolean)
            }

            const containerOpts = {
                Image: image,
                ExposedPorts,
                Env,
                HostConfig: {
                    PortBindings,
                    Binds: Binds.length > 0 ? Binds : undefined,
                    RestartPolicy: { Name: restartPolicy || 'no' },
                    NetworkMode: network || 'bridge'
                },
            }
            if (name) containerOpts.name = name
            if (Cmd) containerOpts.Cmd = Cmd

            const container = await docker.createContainer(containerOpts)
            await container.start()
            return res.json({ success: true, containerId: container.id })
        }

        // Container actions: start, stop, restart, remove
        const container = docker.getContainer(containerId)

        if (action === 'start') {
            await container.start()
            const inspectData = await container.inspect()
            if (!inspectData.State.Running) {
                const logs = await container.logs({ stdout: true, stderr: true, tail: 50 })
                const cleanLogs = logs.toString('utf8')
                    .split('\n')
                    .map(line => line.replace(/^[\u0000-\u0009\u000B-\u001F\u007F]+/, ''))
                    .filter(line => line.trim().length > 0)
                    .join('\n')
                throw new Error(`Container exited immediately. Logs:\n${cleanLogs || 'No logs available'}`)
            }
        } else if (action === 'stop') {
            await container.stop()
        } else if (action === 'restart') {
            await container.restart()
        } else if (action === 'remove') {
            await container.remove({ force: true })
        }

        res.json({ success: true, action, containerId })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * GET /api/containers/:id/export
 * Export container config as docker-compose.yml
 */
router.get('/:id/export', async (req, res) => {
    try {
        const docker = getDocker()
        const container = docker.getContainer(req.params.id)
        const inspect = await container.inspect()

        const config = inspect.Config || {}
        const hostConfig = inspect.HostConfig || {}
        const serviceName = inspect.Name.replace('/', '') || 'app'
        const service = {}

        service.image = config.Image
        service.container_name = serviceName

        // Ports
        const portBindings = hostConfig.PortBindings || {}
        const ports = []
        for (const [containerPort, bindings] of Object.entries(portBindings)) {
            if (bindings) {
                for (const b of bindings) {
                    const cp = containerPort.replace('/tcp', '').replace('/udp', '')
                    ports.push(`${b.HostPort}:${cp}`)
                }
            }
        }
        if (ports.length > 0) service.ports = ports

        if (config.Env && config.Env.length > 0) service.environment = config.Env

        // Volumes
        const mounts = inspect.Mounts || []
        const volumesList = []
        for (const m of mounts) {
            if (m.Type === 'volume') volumesList.push(`${m.Name}:${m.Destination}`)
            else if (m.Type === 'bind') volumesList.push(`${m.Source}:${m.Destination}`)
        }
        if (volumesList.length > 0) service.volumes = volumesList

        if (hostConfig.RestartPolicy?.Name && hostConfig.RestartPolicy.Name !== 'no') {
            service.restart = hostConfig.RestartPolicy.Name
        }

        if (hostConfig.NetworkMode && hostConfig.NetworkMode !== 'default' && hostConfig.NetworkMode !== 'bridge') {
            service.network_mode = hostConfig.NetworkMode
        }

        if (config.Cmd && config.Cmd.length > 0) {
            service.command = config.Cmd.join(' ')
        }

        const compose = { services: { [serviceName]: service } }

        const namedVolumes = mounts.filter(m => m.Type === 'volume').map(m => m.Name)
        if (namedVolumes.length > 0) {
            compose.volumes = {}
            for (const v of namedVolumes) compose.volumes[v] = null
        }

        // Generate YAML
        let yaml = `services:\n  ${serviceName}:\n    image: ${service.image}\n    container_name: ${service.container_name}\n`
        if (service.ports) {
            yaml += `    ports:\n`
            for (const p of service.ports) yaml += `      - "${p}"\n`
        }
        if (service.environment) {
            yaml += `    environment:\n`
            for (const e of service.environment) yaml += `      - ${e}\n`
        }
        if (service.volumes) {
            yaml += `    volumes:\n`
            for (const v of service.volumes) yaml += `      - ${v}\n`
        }
        if (service.restart) yaml += `    restart: ${service.restart}\n`
        if (service.network_mode) yaml += `    network_mode: ${service.network_mode}\n`
        if (service.command) yaml += `    command: ${service.command}\n`
        if (namedVolumes.length > 0) {
            yaml += `\nvolumes:\n`
            for (const v of namedVolumes) yaml += `  ${v}:\n`
        }

        res.json({ yaml, compose })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * POST /api/containers/:id/snapshot
 * Commit container to image
 */
router.post('/:id/snapshot', async (req, res) => {
    try {
        const docker = getDocker()
        const container = docker.getContainer(req.params.id)
        const { repo, tag, comment } = req.body

        if (!repo) return res.status(400).json({ error: 'Repository name is required' })

        await container.inspect() // Ensure exists

        const commitOpts = {
            repo,
            tag: tag || 'latest',
            comment: comment || `Snapshot of ${req.params.id}`
        }

        const data = await container.commit(commitOpts)
        res.json({ success: true, imageId: data.Id })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * POST /api/containers/:id/recreate
 * Recreate container with new config
 */
router.post('/:id/recreate', async (req, res) => {
    const { env, ports, restartPolicy, mounts, network } = req.body

    try {
        const docker = getDocker()
        const oldContainer = docker.getContainer(req.params.id)
        const inspectData = await oldContainer.inspect()

        const name = inspectData.Name.replace(/^\//, '')
        const image = inspectData.Config.Image

        // Process Ports
        const portBindings = {}
        const exposedPorts = {}
        if (ports && Array.isArray(ports)) {
            ports.forEach(p => {
                if (p.containerPort) {
                    const protocol = p.protocol || 'tcp'
                    const cPortString = `${p.containerPort}/${protocol}`
                    exposedPorts[cPortString] = {}
                    if (p.hostPort) {
                        portBindings[cPortString] = [{ HostPort: String(p.hostPort) }]
                    }
                }
            })
        }

        // Process Mounts
        const binds = []
        if (mounts && Array.isArray(mounts)) {
            mounts.forEach(m => {
                if (m.source && m.destination) binds.push(`${m.source}:${m.destination}`)
            })
        }

        const newConfig = {
            Image: image,
            name,
            Env: env || inspectData.Config.Env,
            Cmd: inspectData.Config.Cmd,
            Entrypoint: inspectData.Config.Entrypoint,
            WorkingDir: inspectData.Config.WorkingDir,
            Labels: inspectData.Config.Labels,
            ExposedPorts: ports ? exposedPorts : inspectData.Config.ExposedPorts,
            HostConfig: {
                ...inspectData.HostConfig,
                PortBindings: ports ? portBindings : inspectData.HostConfig.PortBindings,
                Binds: mounts ? binds : inspectData.HostConfig.Binds,
                RestartPolicy: restartPolicy ? { Name: restartPolicy } : inspectData.HostConfig.RestartPolicy,
            }
        }

        if (network) {
            newConfig.NetworkingConfig = { EndpointsConfig: { [network]: {} } }
        } else if (inspectData.NetworkSettings?.Networks) {
            newConfig.NetworkingConfig = { EndpointsConfig: inspectData.NetworkSettings.Networks }
        }

        // Stop + remove old
        if (inspectData.State.Running) await oldContainer.stop()
        await oldContainer.remove({ force: true })

        // Create + start new
        const newContainer = await docker.createContainer(newConfig)
        await newContainer.start()

        res.json({ success: true, newId: newContainer.id })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * GET /api/containers/:id/files
 * Browse container filesystem
 */
router.get('/:id/files', async (req, res) => {
    try {
        const docker = getDocker()
        const container = docker.getContainer(req.params.id)
        const filePath = req.query.path || '/'
        const action = req.query.action || 'list'

        const info = await container.inspect()
        if (!info.State.Running) {
            return res.status(400).json({ error: 'Container must be running to view files' })
        }

        if (action === 'read') {
            const exec = await container.exec({
                Cmd: ['cat', filePath],
                AttachStdout: true,
                AttachStderr: true,
            })

            const stream = await exec.start({ hijack: true, stdin: false })

            // Add timeout for file reading
            const timeout = setTimeout(() => {
                if (!res.headersSent) {
                    stream.destroy()
                    res.status(504).json({ error: 'File reading timed out' })
                }
            }, 15000)

            let output = ''
            docker.modem.demuxStream(stream, {
                write: (data) => { output += data.toString('utf8') }
            }, {
                write: (data) => { output += data.toString('utf8') }
            })

            stream.on('end', () => {
                clearTimeout(timeout)
                if (!res.headersSent) {
                    res.json({ content: output })
                }
            })
            stream.on('error', (err) => {
                clearTimeout(timeout)
                if (!res.headersSent) {
                    res.status(500).json({ error: err.message })
                }
            })
            return
        }

        // action === 'list'
        const exec = await container.exec({
            Cmd: ['ls', '-la', '--time-style=long-iso', filePath],
            AttachStdout: true,
            AttachStderr: true,
        })

        const stream = await exec.start({ hijack: true, stdin: false })

        // Add timeout to prevent hanging requests
        const timeout = setTimeout(() => {
            if (!res.headersSent) {
                stream.destroy()
                res.status(504).json({ error: 'File listing timed out' })
            }
        }, 15000)

        let output = ''
        docker.modem.demuxStream(stream, {
            write: (data) => { output += data.toString('utf8') }
        }, {
            write: (data) => { output += data.toString('utf8') }
        })

        stream.on('end', () => {
            clearTimeout(timeout)
            if (res.headersSent) return
            if (output.includes('No such file or directory') || output.includes('Not a directory')) {
                return res.status(400).json({ error: output.trim() })
            }

            const lines = output.split('\n').filter(Boolean)
            const files = []

            for (const line of lines) {
                if (line.startsWith('total ')) continue
                const parts = line.trim().split(/\s+/)

                if (parts.length >= 8) {
                    const permissions = parts[0]
                    const isDir = permissions.startsWith('d')
                    const isSymlink = permissions.startsWith('l')

                    let nameInfo = parts.slice(7).join(' ')
                    let symlinkTarget = null

                    if (isSymlink && nameInfo.includes(' -> ')) {
                        const symParts = nameInfo.split(' -> ')
                        nameInfo = symParts[0]
                        symlinkTarget = symParts[1]
                    }

                    if (nameInfo === '.') continue
                    if (nameInfo === '..' && filePath === '/') continue

                    files.push({
                        name: nameInfo,
                        isDirectory: isDir,
                        isSymlink,
                        symlinkTarget,
                        size: parseInt(parts[4]) || 0,
                        owner: parts[2],
                        group: parts[3],
                        permissions,
                        modified: `${parts[5]} ${parts[6]}`,
                    })
                }
            }

            files.sort((a, b) => {
                if (a.name === '..') return -1
                if (b.name === '..') return 1
                if (a.isDirectory && !b.isDirectory) return -1
                if (!a.isDirectory && b.isDirectory) return 1
                return a.name.localeCompare(b.name)
            })

            res.json({ files, path: filePath })
        })

        stream.on('error', (err) => res.status(500).json({ error: err.message }))
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

/**
 * PUT /api/containers/:id/files
 * Write file content inside container
 */
router.put('/:id/files', async (req, res) => {
    try {
        const docker = getDocker()
        const container = docker.getContainer(req.params.id)
        const { path: filePath, content } = req.body

        if (!filePath) return res.status(400).json({ error: 'File path is required' })

        const info = await container.inspect()
        if (!info.State.Running) {
            return res.status(400).json({ error: 'Container must be running to edit files' })
        }

        const exec = await container.exec({
            Cmd: ['sh', '-c', 'cat > "$1"', 'sh', filePath],
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
        })

        const stream = await exec.start({ hijack: true, stdin: true })

        stream.write(content || '')
        stream.end()

        let stderr = ''
        docker.modem.demuxStream(stream, {
            write: () => { }
        }, {
            write: (data) => { stderr += data.toString('utf8') }
        })

        stream.on('end', () => {
            if (stderr && stderr.trim()) {
                res.status(500).json({ error: stderr.trim() })
            } else {
                res.json({ success: true })
            }
        })

        stream.on('error', (err) => res.status(500).json({ error: err.message }))
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

export default router
