/* 硬件信息：基于 systeminformation（成熟开源）本地采集，不上传 */
import si from 'systeminformation'

export interface HardwareSection<T> {
  ok: boolean
  error?: string
  data: T | null
  fetchedAt: number
}

function section<T>(data: T | null, error?: string): HardwareSection<T> {
  return { ok: !error && data != null, error, data, fetchedAt: Date.now() }
}

async function safe<T>(fn: () => Promise<T>): Promise<HardwareSection<T>> {
  try {
    const data = await fn()
    return section(data)
  } catch (err) {
    return section<T>(null, err instanceof Error ? err.message : String(err))
  }
}

/** 整机概览：系统 / 机型 / BIOS / 安全状态（实现；缓存包装见文件尾部） */
async function getSystemOverviewImpl() {
  return safe(async () => {
    const [system, bios, baseboard, osInfo, cpu, mem] = await Promise.all([
      si.system(),
      si.bios(),
      si.baseboard(),
      si.osInfo(),
      si.cpu(),
      si.mem()
    ])
    return {
      manufacturer: system.manufacturer,
      model: system.model,
      version: system.version,
      serial: system.serial,
      uuid: system.uuid,
      sku: system.sku,
      virtual: system.virtual,
      os: `${osInfo.distro} ${osInfo.release} (${osInfo.arch})`,
      kernel: osInfo.kernel,
      hostname: osInfo.hostname,
      biosVendor: bios.vendor,
      biosVersion: bios.version,
      biosReleaseDate: bios.releaseDate,
      boardVendor: baseboard.manufacturer,
      boardModel: baseboard.model,
      cpuBrand: cpu.brand,
      cpuCores: cpu.cores,
      cpuPhysicalCores: cpu.physicalCores,
      totalMemGb: Math.round((mem.total / 1024 / 1024 / 1024) * 10) / 10
    }
  })
}

/** CPU 与内存（实现） */
async function getCpuMemoryImpl() {
  return safe(async () => {
    const [cpu, mem, memLayout] = await Promise.all([si.cpu(), si.mem(), si.memLayout()])
    return {
      brand: cpu.brand,
      manufacturer: cpu.manufacturer,
      vendor: cpu.vendor,
      family: cpu.family,
      model: cpu.model,
      stepping: cpu.stepping,
      revision: cpu.revision,
      speed: cpu.speed,
      speedMin: cpu.speedMin,
      speedMax: cpu.speedMax,
      cores: cpu.cores,
      physicalCores: cpu.physicalCores,
      processors: cpu.processors,
      socket: cpu.socket,
      cache: cpu.cache,
      flags: String(cpu.flags || '')
        .split(' ')
        .filter(Boolean)
        .slice(0, 24),
      memTotal: mem.total,
      memFree: mem.free,
      memUsed: mem.used,
      memActive: mem.active,
      memAvailable: mem.available,
      swaptotal: mem.swaptotal,
      swapused: mem.swapused,
      modules: (memLayout || []).map((m) => ({
        bank: m.bank,
        type: m.type,
        clockSpeed: m.clockSpeed,
        size: m.size,
        manufacturer: m.manufacturer,
        partNum: m.partNum,
        serialNum: m.serialNum
      }))
    }
  })
}

/** 显卡与显示器（实现） */
async function getGraphicsImpl() {
  return safe(async () => {
    const [graphics, osInfo] = await Promise.all([si.graphics(), si.osInfo()])
    return {
      controllers: (graphics.controllers || []).map((c) => ({
        vendor: c.vendor,
        model: c.model,
        bus: c.bus,
        vram: c.vram,
        vramDynamic: c.vramDynamic,
        driverVersion: c.driverVersion,
        subDeviceId: c.subDeviceId,
        pciBus: c.pciBus
      })),
      displays: (graphics.displays || []).map((d) => ({
        vendor: d.vendor,
        model: d.model,
        serial: d.serial,
        resolutionX: d.resolutionX,
        resolutionY: d.resolutionY,
        pixelDepth: d.pixelDepth,
        sizeX: d.sizeX,
        sizeY: d.sizeY,
        currentResX: d.currentResX,
        currentResY: d.currentResY,
        positionX: d.positionX,
        positionY: d.positionY,
        currentRefreshRate: d.currentRefreshRate
      })),
      os: osInfo.distro
    }
  })
}

/** 主板与固件 / PCIe（实现） */
async function getBoardFirmwareImpl() {
  return safe(async () => {
    const [baseboard, bios, chassis] = await Promise.all([si.baseboard(), si.bios(), si.chassis()])
    const pci: unknown[] = []
    return {
      board: {
        manufacturer: baseboard.manufacturer,
        model: baseboard.model,
        version: baseboard.version,
        serial: baseboard.serial,
        assetTag: baseboard.assetTag,
        memMax: baseboard.memMax,
        memSlots: baseboard.memSlots
      },
      bios: {
        vendor: bios.vendor,
        version: bios.version,
        releaseDate: bios.releaseDate,
        revision: bios.revision
      },
      chassis: {
        manufacturer: chassis.manufacturer,
        model: chassis.model,
        type: chassis.type,
        serial: chassis.serial
      },
      pciDevices: Array.isArray(pci)
        ? pci.slice(0, 40).map((p) => {
            const item = p as Record<string, unknown>
            return {
              id: String(item.id ?? ''),
              class: String(item.class ?? ''),
              subclass: String(item.subclass ?? ''),
              vendor: String(item.vendor ?? ''),
              name: String(item.name ?? '')
            }
          })
        : []
    }
  })
}

/** 磁盘与健康（实现） */
async function getDiskHealthImpl() {
  return safe(async () => {
    const [fsSize, diskLayout, blockDevices] = await Promise.all([
      si.fsSize(),
      si.diskLayout(),
      si.blockDevices()
    ])
    return {
      filesystems: (fsSize || []).map((f) => ({
        fs: f.fs,
        type: f.type,
        size: f.size,
        used: f.used,
        available: f.available,
        use: f.use,
        mount: f.mount
      })),
      physical: (diskLayout || []).map((d) => ({
        device: d.device,
        type: d.type,
        name: d.name,
        vendor: d.vendor,
        size: d.size,
        interfaceType: d.interfaceType,
        smartStatus: d.smartStatus,
        temperature: d.temperature
      })),
      partitions: (blockDevices || [])
        .slice(0, 32)
        .map((b) => ({
          name: b.name,
          identifier: b.identifier,
          type: b.type,
          label: b.label,
          mount: b.mount,
          size: b.size,
          physical: b.physical,
          model: b.model
        }))
    }
  })
}

/** 网络与设备（实现） */
async function getNetworkDevicesImpl() {
  return safe(async () => {
    const [networkInterfaces, networkStats, usb, audio, bluetooth] = await Promise.all([
      si.networkInterfaces(),
      si.networkStats().catch(() => [] as Awaited<ReturnType<typeof si.networkStats>>),
      si.usb().catch(() => [] as Awaited<ReturnType<typeof si.usb>>),
      si.audio().catch(() => [] as Awaited<ReturnType<typeof si.audio>>),
      si.bluetoothDevices().catch(() => [] as Awaited<ReturnType<typeof si.bluetoothDevices>>)
    ])

    const ifaces = Array.isArray(networkInterfaces) ? networkInterfaces : [networkInterfaces]

    return {
      interfaces: ifaces.map((n) => ({
        iface: n.iface,
        ifaceName: n.ifaceName,
        ip4: n.ip4,
        ip6: n.ip6,
        mac: n.mac,
        speed: n.speed,
        dhcp: n.dhcp,
        type: n.type,
        operstate: n.operstate,
        default: n.default
      })),
      stats: (networkStats || []).map((s) => ({
        iface: s.iface,
        rx_bytes: s.rx_bytes,
        tx_bytes: s.tx_bytes,
        rx_sec: s.rx_sec,
        tx_sec: s.tx_sec
      })),
      usb: (usb || []).slice(0, 40).map((u) => ({
        id: u.id,
        name: u.name,
        type: u.type,
        manufacturer: u.manufacturer,
        serialNumber: u.serialNumber
      })),
      audio: (audio || []).slice(0, 20).map((a) => ({
        name: a.name,
        manufacturer: a.manufacturer,
        driver: a.driver
      })),
      bluetooth: (bluetooth || []).slice(0, 20).map((b) => ({
        name: b.name,
        batteryPercent: b.batteryPercent,
        connected: b.connected
      }))
    }
  })
}

/** 电源与传感器（实现） */
async function getPowerSensorsImpl() {
  return safe(async () => {
    const [battery, chassis, cpuTemperature, fsSize] = await Promise.all([
      si.battery(),
      si.chassis().catch(() => null),
      si.cpuTemperature().catch(() => ({ main: null as number | null })),
      si.fsSize().catch(() => [])
    ])

    let sensors: {
      cpuTemp: number | null
      cpuLoad: number | null
      memUsedPercent: number | null
      diskUsePercent: number | null
    } = { cpuTemp: null, cpuLoad: null, memUsedPercent: null, diskUsePercent: null }
    try {
      const [load, mem] = await Promise.all([si.currentLoad(), si.mem()])
      sensors = {
        cpuTemp: cpuTemperature?.main ?? null,
        cpuLoad: Math.round((load?.currentLoad ?? 0) * 10) / 10,
        memUsedPercent: mem.total ? Math.round((mem.used / mem.total) * 1000) / 10 : null,
        diskUsePercent: fsSize?.length ? Math.round(fsSize[0].use * 10) / 10 : null
      }
    } catch {
      /* 传感器可选 */
    }

    return {
      battery: battery
        ? {
            hasBattery: battery.hasBattery,
            isCharging: battery.isCharging,
            designedCapacity: battery.designedCapacity,
            maxCapacity: battery.maxCapacity,
            currentCapacity: battery.currentCapacity,
            voltage: battery.voltage,
            percent: battery.percent,
            timeRemaining: battery.timeRemaining,
            acConnected: battery.acConnected,
            type: battery.type,
            model: battery.model,
            manufacturer: battery.manufacturer,
            serial: battery.serial
          }
        : null,
      chassis: chassis
        ? {
            manufacturer: chassis.manufacturer,
            model: chassis.model,
            type: chassis.type
          }
        : null,
      sensors
    }
  })
}

/** 汇总（一键刷新） */
export async function getHardwareSummary() {
  const [system, cpuMem, graphics, board, disk, network, power] = await Promise.all([
    getSystemOverview(),
    getCpuMemory(),
    getGraphics(),
    getBoardFirmware(),
    getDiskHealth(),
    getNetworkDevices(),
    getPowerSensors()
  ])
  return { system, cpuMem, graphics, board, disk, network, power }
}

/* ---------- 缓存与预热 ----------
 * Windows 上 si 的 diskLayout / graphics / networkInterfaces 等探测单次可达数秒，
 * 是面板「获取时间长」的根源。对策：
 * 1. TTL 缓存（静态数据 5 分钟、动态数据 15 秒）——切面板 / 重复打开秒出；
 * 2. in-flight 去重——并发请求合并为一次探测；
 * 3. 应用启动后台预热（warmupHardware）——用户点开面板时大多已就绪。
 * 「刷新」按钮传 force=true 绕过缓存强制重采。
 */
type AnySection = HardwareSection<unknown>
const cacheMap = new Map<string, { at: number; value: AnySection }>()
const inflightMap = new Map<string, Promise<AnySection>>()

function withCache(key: string, ttlMs: number, fn: () => Promise<AnySection>, force = false): Promise<AnySection> {
  if (force) {
    cacheMap.delete(key)
  } else {
    const hit = cacheMap.get(key)
    if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value)
  }
  const running = inflightMap.get(key)
  if (running) return running
  const p = fn()
    .then((v) => {
      cacheMap.set(key, { at: Date.now(), value: v })
      return v
    })
    .finally(() => {
      inflightMap.delete(key)
    })
  inflightMap.set(key, p)
  return p
}

const MIN = 60_000
export function getSystemOverview(force = false) {
  return withCache('system', 5 * MIN, getSystemOverviewImpl, force)
}
export function getCpuMemory(force = false) {
  return withCache('cpuMem', 15_000, getCpuMemoryImpl, force)
}
export function getGraphics(force = false) {
  return withCache('graphics', 5 * MIN, getGraphicsImpl, force)
}
export function getBoardFirmware(force = false) {
  return withCache('board', 5 * MIN, getBoardFirmwareImpl, force)
}
export function getDiskHealth(force = false) {
  return withCache('disk', 5 * MIN, getDiskHealthImpl, force)
}
export function getNetworkDevices(force = false) {
  return withCache('network', MIN, getNetworkDevicesImpl, force)
}
export function getPowerSensors(force = false) {
  return withCache('power', 15_000, getPowerSensorsImpl, force)
}

let warmed = false
/** 应用启动后台预热：并行预采集全部硬件数据（各自 safe 包装，失败静默） */
export function warmupHardware(): void {
  if (warmed) return
  warmed = true
  void getSystemOverview().catch(() => undefined)
  void getCpuMemory().catch(() => undefined)
  void getGraphics().catch(() => undefined)
  void getBoardFirmware().catch(() => undefined)
  void getDiskHealth().catch(() => undefined)
  void getNetworkDevices().catch(() => undefined)
  void getPowerSensors().catch(() => undefined)
}
