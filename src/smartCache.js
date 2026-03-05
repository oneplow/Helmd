/**
 * helmd/src/smartCache.js — Singleton Event-Driven Cache
 *
 * Metrics (CPU/RAM/Storage): จาก os module ล้วนๆ — ไม่ยิง Docker
 * Inventory (containers/images/policies): 3 Docker API calls ทุก 15 วิ หรือเมื่อมี event
 * Docker Events: await docker.getEvents() (Promise-based, dockerode v4)
 *
 * SSE route subscribe ผ่าน subscribe() — ไม่มี setInterval ใน route
 */

import os from 'os'
import fs from 'fs'
import { getDocker } from './docker.js'

// ─── Config ──────────────────────────────────────────────────────────────────
const METRICS_INTERVAL = 5_000    // CPU/RAM/Storage refresh (ms)
const INVENTORY_INTERVAL = 15_000  // containers/images/policies refresh (ms)
const EVENT_DEBOUNCE = 2_000       // debounce after Docker event (ms)

// ─── State ───────────────────────────────────────────────────────────────────
let cache = emptySnapshot()
let listeners = new Set()
let metricsTimer = null
let inventoryTimer = null
let eventStream = null
let eventRetryTimer = null
let inventoryDebounce = null
let stopped = true

// CPU delta tracking
let lastCpuInfo = null

// ─── Public API ──────────────────────────────────────────────────────────────

export function startCache() {
    if (!stopped) return
    stopped = false
    console.log('[smartCache] Starting cache...')

    // Initial fetch
    fetchMetrics()
    fetchInventory()

    // Periodic refresh
    metricsTimer = setInterval(fetchMetrics, METRICS_INTERVAL)
    inventoryTimer = setInterval(fetchInventory, INVENTORY_INTERVAL)

    // Docker event stream
    connectEventStream()

    console.log('[smartCache] Started — metrics every', METRICS_INTERVAL / 1000, 's, inventory every', INVENTORY_INTERVAL / 1000, 's')
}

export function stopCache() {
    stopped = true
    clearInterval(metricsTimer)
    clearInterval(inventoryTimer)
    clearTimeout(eventRetryTimer)
    clearTimeout(inventoryDebounce)
    try { eventStream?.destroy() } catch { }
    listeners.clear()
    console.log('[smartCache] Stopped')
}

export function getCachedStats() {
    return { ...cache }
}

export function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptySnapshot() {
    return {
        containers: { total: 0, running: 0, stopped: 0, paused: 0 },
        images: { total: 0 },
        memory: { total: 0, used: 0, containersUsed: 0 },
        cpu: { usedPercent: 0, loadAvg: 0 },
        storage: { total: 0, used: 0, usedPercent: 0 },
        ncpu: 0,
        serverVersion: '',
        operatingSystem: '',
        architecture: '',
        policies: {},
    }
}

function notify() {
    const snap = { ...cache }
    for (const fn of listeners) {
        try { fn(snap) } catch { }
    }
}

// ─── CPU (delta-based, same algorithm as old system.js) ──────────────────────

function getCpuUsage() {
    const cpus = os.cpus()
    let user = 0, nice = 0, sys = 0, idle = 0, irq = 0
    for (const cpu of cpus) {
        user += cpu.times.user
        nice += cpu.times.nice
        sys += cpu.times.sys
        idle += cpu.times.idle
        irq += cpu.times.irq
    }
    const total = user + nice + sys + idle + irq

    if (!lastCpuInfo) {
        lastCpuInfo = { total, idle, ts: Date.now() }
        return Math.min(100, (os.loadavg()[0] / (cpus.length || 1)) * 100)
    }

    const diffTotal = total - lastCpuInfo.total
    const diffIdle = idle - lastCpuInfo.idle
    lastCpuInfo = { total, idle, ts: Date.now() }

    if (diffTotal <= 0) return 0
    return Math.min(100, Math.max(0, ((diffTotal - diffIdle) / diffTotal) * 100))
}

// ─── Metrics (OS only — zero Docker) ─────────────────────────────────────────

function fetchMetrics() {
    if (stopped) return
    try {
        const totalMem = os.totalmem()
        const freeMem = os.freemem()
        const usedMem = totalMem - freeMem
        const cpuUsedPercent = getCpuUsage()
        const loadAvg = os.loadavg()[0]
        const ncpu = os.cpus().length || 1

        // Storage
        let storage = { total: 0, used: 0, usedPercent: 0 }
        try {
            if (fs.statfsSync) {
                const stats = fs.statfsSync('/')
                storage.total = stats.bsize * stats.blocks
                storage.used = stats.bsize * (stats.blocks - stats.bfree)
                storage.usedPercent = storage.total > 0 ? (storage.used / storage.total) * 100 : 0
            }
        } catch { }

        cache = {
            ...cache,
            memory: { ...cache.memory, total: totalMem, used: usedMem },
            cpu: { usedPercent: parseFloat(cpuUsedPercent.toFixed(1)), loadAvg },
            storage,
            ncpu,
        }

        notify()
    } catch (e) {
        console.warn('[smartCache] metrics error:', e.message)
    }
}

// ─── Inventory (3 Docker API calls) ──────────────────────────────────────────

async function fetchInventory() {
    if (stopped) return
    try {
        const docker = getDocker()
        const [info, images, containers] = await Promise.all([
            docker.info(),
            docker.listImages(),
            docker.listContainers({ all: true }),
        ])

        // Policies
        const danglingImages = images.filter(img => img.RepoTags?.includes('<none>:<none>')).length
        const officialImagesCount = images.filter(img => img.RepoTags?.some(tag => !tag.includes('/'))).length

        // Container mem stats (lightweight — max 5, 800ms timeout)
        let containersMemUsed = 0
        try {
            const running = containers.filter(c => c.State === 'running')
            const statsPromises = running.slice(0, 5).map(async (c) => {
                try {
                    const container = docker.getContainer(c.Id)
                    const stats = await Promise.race([
                        container.stats({ stream: false }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 800))
                    ])
                    return stats.memory_stats?.usage || 0
                } catch { return 0 }
            })
            const results = await Promise.all(statsPromises)
            containersMemUsed = results.reduce((a, b) => a + b, 0)
        } catch { }

        cache = {
            ...cache,
            containers: {
                total: info.Containers ?? containers.length,
                running: info.ContainersRunning ?? containers.filter(c => c.State === 'running').length,
                stopped: info.ContainersStopped ?? containers.filter(c => c.State === 'exited').length,
                paused: info.ContainersPaused ?? containers.filter(c => c.State === 'paused').length,
            },
            images: { total: images.length },
            memory: { ...cache.memory, containersUsed: containersMemUsed },
            serverVersion: info.ServerVersion || cache.serverVersion,
            operatingSystem: info.OperatingSystem || cache.operatingSystem,
            architecture: info.Architecture || cache.architecture,
            policies: {
                healthyImagesCount: images.length - danglingImages,
                resourceLimitsSet: 0,
                officialBaseImages: officialImagesCount,
            },
        }

        notify()
    } catch (e) {
        console.warn('[smartCache] inventory error:', e.message)
    }
}

// ─── Docker Event Stream ─────────────────────────────────────────────────────

async function connectEventStream() {
    if (stopped) return
    try {
        const docker = getDocker()
        const stream = await docker.getEvents({
            filters: JSON.stringify({ type: ['container', 'image'] })
        })

        eventStream = stream

        stream.on('data', () => {
            if (stopped) return
            // Debounced inventory refresh on any Docker event
            clearTimeout(inventoryDebounce)
            inventoryDebounce = setTimeout(() => fetchInventory(), EVENT_DEBOUNCE)
        })

        stream.on('end', () => {
            if (!stopped) scheduleEventRetry()
        })

        stream.on('error', (err) => {
            console.warn('[smartCache] event stream error:', err.message)
            if (!stopped) scheduleEventRetry()
        })

        console.log('[smartCache] Docker event stream connected')
    } catch (e) {
        console.warn('[smartCache] Failed to connect event stream:', e.message)
        scheduleEventRetry()
    }
}

function scheduleEventRetry(delay = 15_000) {
    clearTimeout(eventRetryTimer)
    eventRetryTimer = setTimeout(() => {
        if (!stopped) connectEventStream()
    }, delay)
}
