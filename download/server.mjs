import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const binary = process.env.YTDLP_BINARY || 'yt-dlp'
const port = Number(process.env.PORT || 8080)
const maxJobs = Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2)
const origins = new Set(
  (process.env.SITE_ORIGINS || 'https://alkulify.assoli.site,http://localhost:4321').split(','),
)
const commonArgs = ['--ignore-config', '--no-color', '--no-progress', '--js-runtimes', 'node']

let activeJobs = 0
let updating

export function validateUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid URL')
  const url = new URL(value)
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:') throw new Error('Only YouTube URLs are supported')
  const direct = host === 'youtu.be' && /^\/[\w-]{6,}\/?$/.test(url.pathname)
  const youtube = host === 'youtube.com' || host.endsWith('.youtube.com')
  const watch = url.pathname === '/watch' && /^[\w-]{6,}$/.test(url.searchParams.get('v') || '')
  const playlist =
    url.pathname === '/playlist' && /^[\w-]{6,}$/.test(url.searchParams.get('list') || '')
  const named = /^\/(shorts|live|embed)\/[\w-]{6,}\/?$/.test(url.pathname)
  const privateEmbed =
    (host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) && named
  if (!direct && !(youtube && (watch || playlist || named)) && !privateEmbed)
    throw new Error('Only YouTube video and playlist URLs are supported')
  return url.href
}

export function qualitiesFromInfo(info) {
  const item = info.formats ? info : info.entries?.find((entry) => entry?.formats)
  return [
    ...new Set(
      (item?.formats || [])
        .filter((format) => format.vcodec !== 'none')
        .map((format) =>
          Number.isInteger(format.width) && Number.isInteger(format.height)
            ? Math.min(format.width, format.height)
            : format.height,
        )
        .filter(Number.isInteger),
    ),
  ].sort((a, b) => a - b)
}

export function downloadArgs(url, type, quality, output) {
  const args = [...commonArgs, '--windows-filenames', '--output', output]
  if (type === 'audio') {
    args.push('--format', 'bestaudio/best', '--extract-audio', '--audio-format', 'best')
  } else {
    if (quality !== 'best' && !/^\d{2,4}$/.test(quality)) throw new Error('Invalid quality')
    args.push('--format', 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4/mkv')
    if (quality !== 'best') args.push('--format-sort', `res:${quality}`)
  }
  return [...args, '--', url]
}

function run(args, { cwd, signal, maxOutput = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const collect = (key, chunk) => {
      if (key === 'stdout') stdout = (stdout + chunk).slice(-maxOutput)
      else stderr = (stderr + chunk).slice(-64 * 1024)
    }
    child.stdout.on('data', (chunk) => collect('stdout', chunk))
    child.stderr.on('data', (chunk) => collect('stderr', chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`))
    })
  })
}

export async function updateYtDlp() {
  updating ??= run(['--ignore-config', '--no-color', '--update-to', 'nightly'])
    .catch((error) => {
      console.error(`yt-dlp update failed: ${error.message}`)
    })
    .finally(() => {
      updating = undefined
    })
  return updating
}

export async function withUpdateRetry(args, options, execute = run, update = updateYtDlp) {
  try {
    return await execute(args, options)
  } catch (firstError) {
    if (firstError.name === 'AbortError') throw firstError
    await update()
    try {
      return await execute(args, options)
    } catch (retryError) {
      retryError.cause = firstError
      throw retryError
    }
  }
}

function cors(req, res) {
  const origin = req.headers.origin
  if (origin && origins.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
}

function json(req, res, status, body) {
  cors(req, res)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function body(req) {
  let value = ''
  for await (const chunk of req) {
    value += chunk
    if (value.length > 4096) throw new Error('Request is too large')
  }
  return JSON.parse(value || '{}')
}

async function info(req, res) {
  const url = validateUrl((await body(req)).url)
  const { stdout } = await withUpdateRetry([
    ...commonArgs,
    '--quiet',
    '--dump-single-json',
    '--playlist-items',
    '1',
    '--',
    url,
  ])
  const data = JSON.parse(stdout)
  const playlist = data._type === 'playlist' || data._type === 'multi_video'
  json(req, res, 200, {
    title: data.title || data.entries?.[0]?.title || 'YouTube',
    playlist,
    count: playlist ? data.playlist_count || data.n_entries || data.entries?.length : 1,
    qualities: qualitiesFromInfo(data),
  })
}

function disposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download'
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

async function sendFile(req, res, file, cleanup) {
  const details = await stat(file)
  cors(req, res)
  res.writeHead(200, {
    'Content-Disposition': disposition(basename(file)),
    'Content-Length': details.size,
    'Content-Type': file.endsWith('.zip') ? 'application/zip' : 'application/octet-stream',
  })
  createReadStream(file).on('error', (error) => res.destroy(error)).pipe(res)
  res.once('close', cleanup)
}

async function download(req, res) {
  if (activeJobs >= maxJobs) return json(req, res, 429, { error: 'Downloader is busy' })
  activeJobs++
  let held = true
  const release = () => {
    if (!held) return
    held = false
    activeJobs--
  }
  const controller = new AbortController()
  res.once('close', () => controller.abort())
  let root
  try {
    const requestUrl = new URL(req.url, 'http://localhost')
    const url = validateUrl(requestUrl.searchParams.get('url'))
    const type = requestUrl.searchParams.get('type') === 'audio' ? 'audio' : 'video'
    const quality = requestUrl.searchParams.get('quality') || 'best'
    root = await mkdtemp(join(tmpdir(), 'yt-dlp-'))
    const media = join(root, 'media')
    await mkdir(media)
    await withUpdateRetry(
      downloadArgs(url, type, quality, join(media, '%(title).180B [%(id)s].%(ext)s')),
      { signal: controller.signal },
    )
    const files = (await readdir(media, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.name.endsWith('.part'))
      .map((entry) => join(media, entry.name))
    if (!files.length) throw new Error('yt-dlp produced no files')
    let result = files[0]
    if (files.length > 1) {
      result = join(root, 'playlist.zip')
      await new Promise((resolve, reject) => {
        const zip = spawn('python3', ['-m', 'zipfile', '-c', result, '.'], { cwd: media })
        zip.on('error', reject)
        zip.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`zipfile exited with code ${code}`)),
        )
      })
    }
    const finishedRoot = root
    const cleanup = () => {
      release()
      rm(finishedRoot, { recursive: true, force: true }).catch(console.error)
    }
    await sendFile(req, res, result, cleanup)
    root = undefined
  } finally {
    if (root) {
      release()
      await rm(root, { recursive: true, force: true })
    }
  }
}

export function handler(req, res) {
  cors(req, res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' })
    return res.end()
  }
  const path = new URL(req.url, 'http://localhost').pathname
  if (req.method === 'GET' && path === '/health') {
    return run(['--version'])
      .then(({ stdout }) => json(req, res, 200, { status: 'ok', version: stdout.trim() }))
      .catch((error) => json(req, res, 503, { error: error.message }))
  }
  const task = req.method === 'POST' && path === '/info' ? info(req, res) : req.method === 'GET' && path === '/download' ? download(req, res) : null
  if (!task) return json(req, res, 404, { error: 'Not found' })
  task.catch((error) => {
    if (!res.headersSent) json(req, res, error.name === 'AbortError' ? 499 : 400, { error: error.message })
    else res.destroy(error)
  })
}

export async function start() {
  await updateYtDlp()
  return createServer(handler).listen(port, '0.0.0.0', () => {
    console.log(`Downloader listening on :${port}`)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start()
