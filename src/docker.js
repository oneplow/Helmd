import Docker from 'dockerode'

let dockerClient = null

/**
 * Get Docker client connected via unix socket
 */
export function getDocker() {
    if (!dockerClient) {
        const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock'
        dockerClient = new Docker({ socketPath })
    }
    return dockerClient
}
