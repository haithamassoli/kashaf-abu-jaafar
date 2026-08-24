import assert from 'node:assert/strict'
import test from 'node:test'
import { downloadArgs, qualitiesFromInfo, validateUrl, withUpdateRetry } from './server.mjs'

test('accepts YouTube URLs and rejects other hosts', () => {
  assert.equal(validateUrl('https://youtu.be/jNQXAC9IVRw'), 'https://youtu.be/jNQXAC9IVRw')
  assert.equal(
    validateUrl('https://www.youtube.com/playlist?list=PL123456'),
    'https://www.youtube.com/playlist?list=PL123456',
  )
  assert.throws(() => validateUrl('http://youtube.com/watch?v=x'))
  assert.throws(() => validateUrl('https://youtube.com/watch?v='))
  assert.throws(() => validateUrl('https://youtube.com.evil.test/watch?v=x'))
})

test('lists portrait-safe video resolutions from lowest to highest', () => {
  assert.deepEqual(
    qualitiesFromInfo({ formats: [
      { width: 1280, height: 720, vcodec: 'avc1' },
      { width: 144, height: 256, vcodec: 'vp9' },
      { width: 720, height: 1280, vcodec: 'vp9' },
      { height: 1080, vcodec: 'none' },
    ] }),
    [144, 720],
  )
})

test('audio is always best and video quality is bounded', () => {
  assert.deepEqual(
    downloadArgs('https://youtu.be/x', 'audio', '144', '/tmp/out'),
    [
      '--ignore-config', '--no-color', '--no-progress', '--js-runtimes', 'node',
      '--windows-filenames', '--output', '/tmp/out', '--format', 'bestaudio/best',
      '--extract-audio', '--audio-format', 'best', '--', 'https://youtu.be/x',
    ],
  )
  assert.match(downloadArgs('https://youtu.be/x', 'video', '720', '/tmp/out').join(' '), /res:720/)
  assert.throws(() => downloadArgs('https://youtu.be/x', 'video', '720;rm', '/tmp/out'))
})

test('a failed yt-dlp command updates once and retries once', async () => {
  let runs = 0
  let updates = 0
  const result = await withUpdateRetry(
    ['--version'],
    undefined,
    async () => {
      if (++runs === 1) throw new Error('old extractor')
      return { stdout: 'ok' }
    },
    async () => updates++,
  )
  assert.equal(result.stdout, 'ok')
  assert.equal(runs, 2)
  assert.equal(updates, 1)
})
