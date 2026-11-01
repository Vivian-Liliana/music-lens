#!/usr/bin/env node
/**
 * music-lens -- let a text-only model "read" a song.
 *
 *   music-lens doctor              check python / deps / models
 *   music-lens setup [--models small,medium]
 *   music-lens analyze <audio> [--model medium] [--lang auto] [--out DIR]
 *   music-lens separate <audio> [--model htdemucs]
 *
 * Everything runs locally: no API keys, no upload.
 * Models + python env live in $MUSIC_LENS_HOME (default ~/.music-lens).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const ANALYZE_PY = path.join(PKG, 'scripts', 'analyze.py')

const HOME = process.env.MUSIC_LENS_HOME || path.join(os.homedir(), '.music-lens')
const MODELS = path.join(HOME, 'models')
const MIRROR = process.env.HF_ENDPOINT || 'https://hf-mirror.com'

const PIP_PKGS = [
  'faster-whisper',
  'librosa',
  'matplotlib',
  'soundfile',
  'demucs',
  'opencc-python-reimplemented',
]

const MODEL_FILES = ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt']

function log(msg) { process.stdout.write(`${msg}\n`) }
function die(msg) { process.stderr.write(`error: ${msg}\n`); process.exit(1) }

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { out[key] = next; i++ }
      else out[key] = true
    } else out._.push(a)
  }
  return out
}

function candidates() {
  const list = []
  if (process.env.MUSIC_LENS_PYTHON) list.push(process.env.MUSIC_LENS_PYTHON)
  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA
    if (la) {
      for (const v of ['313', '312', '311']) {
        list.push(path.join(la, 'Programs', 'Python', `Python${v}`, 'python.exe'))
      }
    }
  }
  list.push('python3.12', 'python3', 'python')
  return list
}

function findPython() {
  for (const p of candidates()) {
    const r = spawnSync(p, ['-c', 'import sys;print(sys.version_info[:2])'], { encoding: 'utf8' })
    if (r.status === 0) return p
  }
  return null
}

// ffmpeg is optional: only the zero-dependency `spectrogram` command needs it.
function findFfmpeg() {
  const cands = []
  if (process.env.MUSIC_LENS_FFMPEG) cands.push(process.env.MUSIC_LENS_FFMPEG)
  cands.push('ffmpeg')
  if (process.platform === 'win32') {
    cands.push(path.join(os.homedir(), '.dsh', 'bili-whale', 'bin', 'ffmpeg.exe'))
    cands.push('C:\\ffmpeg\\bin\\ffmpeg.exe')
  }
  for (const c of cands) {
    const r = spawnSync(c, ['-version'], { encoding: 'utf8' })
    if (r.status === 0) return c
  }
  return null
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...(opts.env || {}) } })
  return r.status ?? 1
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') }
}

function hasModule(py, mod) {
  return spawnSync(py, ['-c', `import ${mod}`], { stdio: 'ignore' }).status === 0
}

function modelDir(name) { return path.join(MODELS, `faster-whisper-${name}`) }

function modelReady(name) {
  const d = modelDir(name)
  return fs.existsSync(path.join(d, 'model.bin')) && fs.existsSync(path.join(d, 'config.json'))
}

async function downloadModel(name) {
  const dir = modelDir(name)
  fs.mkdirSync(dir, { recursive: true })
  const repo = `Systran/faster-whisper-${name}`
  for (const f of MODEL_FILES) {
    const target = path.join(dir, f)
    let expected = 0
    try {
      const head = await fetch(`${MIRROR}/${repo}/resolve/main/${f}`, { method: 'HEAD' })
      if (!head.ok) { log(`  skip ${f}`); continue }
      expected = Number(head.headers.get('content-length') || 0)
    } catch { log(`  skip ${f}`); continue }

    if (fs.existsSync(target) && fs.statSync(target).size === expected) { log(`  ok   ${f}`); continue }

    log(`  get  ${f}  ${(expected / 1048576).toFixed(1)} MB`)
    const res = await fetch(`${MIRROR}/${repo}/resolve/main/${f}`)
    if (!res.ok) die(`download failed ${f}: ${res.status}`)
    const t0 = Date.now()
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(target))
    const mb = fs.statSync(target).size / 1048576
    log(`       ${mb.toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  }
  return dir
}

async function ensureModel(name) {
  if (modelReady(name)) return modelDir(name)
  log(`model "${name}" not found, downloading from ${MIRROR} ...`)
  return downloadModel(name)
}

// ---------------------------------------------------------------- commands

function cmdDoctor() {
  log(`music-lens home : ${HOME}`)
  const py = findPython()
  if (!py) {
    log('python          : MISSING')
    log(`  install:  ${pythonInstallCommand().manual}`)
    log('  or set MUSIC_LENS_PYTHON=/path/to/python')
  } else {
    const v = capture(py, ['-c', 'import sys;print(sys.version.split()[0])']).out.trim()
    log(`python          : ${py}  (${v})`)
    for (const m of ['faster_whisper', 'librosa', 'demucs']) {
      log(`  ${m.padEnd(16)}: ${hasModule(py, m) ? 'ok' : 'MISSING'}`)
    }
  }
  for (const n of ['small', 'medium', 'large-v3']) {
    const d = modelDir(n)
    log(`model ${n.padEnd(9)}: ${modelReady(n) ? d : 'not downloaded'}`)
  }
  return 0
}

function pythonInstallCommand() {
  if (process.platform === 'win32') {
    return {
      cmd: 'winget',
      args: ['install', '--id', 'Python.Python.3.12', '-e', '--scope', 'user',
        '--accept-package-agreements', '--accept-source-agreements'],
      manual: 'winget install --id Python.Python.3.12 -e --scope user',
    }
  }
  if (process.platform === 'darwin') {
    return { cmd: 'brew', args: ['install', 'python@3.12'], manual: 'brew install python@3.12' }
  }
  return {
    cmd: 'sudo',
    args: ['apt-get', 'install', '-y', 'python3', 'python3-pip', 'python3-venv'],
    manual: 'sudo apt-get install -y python3 python3-pip python3-venv',
  }
}

async function cmdSetup(args) {
  const py = findPython()
  let use = py
  if (!use) {
    const inst = pythonInstallCommand()
    log(`python not found -- trying ${inst.cmd}`)
    let st = 1
    try { st = run(inst.cmd, inst.args) } catch { st = 1 }
    if (st !== 0) {
      die(`could not install python automatically.\n  run manually:  ${inst.manual}\n  then re-run:   music-lens setup\n  (or point MUSIC_LENS_PYTHON at an existing python 3.9+)`)
    }
    use = findPython()
    if (!use) die('python installed but still not on PATH; set MUSIC_LENS_PYTHON')
  }
  log(`python: ${use}`)

  log('installing python packages ...')
  if (run(use, ['-m', 'pip', 'install', '--upgrade', 'pip']) !== 0) log('pip upgrade skipped')
  if (run(use, ['-m', 'pip', 'install', ...PIP_PKGS]) !== 0) die('pip install failed')

  log('installing cpu torch (needed by demucs) ...')
  const torchOk = hasModule(use, 'torch')
  if (!torchOk) {
    run(use, ['-m', 'pip', 'install', 'torch', 'torchaudio',
      '--index-url', 'https://download.pytorch.org/whl/cpu'])
  }

  const wanted = (args.models || 'small').split(',').map(s => s.trim()).filter(Boolean)
  for (const m of wanted) await ensureModel(m)

  log('\nready. try:  music-lens analyze "<song.mp3>" --model medium')
  log('(medium is ~1.5 GB and a lot better on Chinese; download it with: music-lens setup --models medium)')
  return 0
}

async function cmdAnalyze(args) {
  const audio = args._[0]
  if (!audio) die('usage: music-lens analyze <audio> [--model medium] [--lang auto] [--out DIR]')
  const py = findPython() || die('python not found -- run `music-lens setup`')
  const modelName = args.model || 'medium'
  let modelArg = modelName
  if (!modelName.includes(path.sep) && !modelName.includes('/')) {
    modelArg = await ensureModel(modelName)
  }
  const argv = [ANALYZE_PY, path.resolve(audio), '--model', modelArg, '--lang', args.lang || 'auto']
  if (args.out) argv.push('--out', path.resolve(args.out))
  return run(py, argv)
}

/**
 * Zero-dependency quick look: needs only ffmpeg, no python, no models.
 * Produces a mel-ish spectrogram and a waveform picture.
 */
async function cmdSpectrogram(args) {
  const audio = args._[0]
  if (!audio) die('usage: music-lens spectrogram <audio> [--out DIR] [--size 1600x900]')
  const src = path.resolve(audio)
  if (!fs.existsSync(src)) die(`audio not found: ${src}`)

  const ff = findFfmpeg()
  if (!ff) {
    die('ffmpeg not found.\n  install:  winget install Gyan.FFmpeg\n  or set:   MUSIC_LENS_FFMPEG=C:\\path\\to\\ffmpeg.exe')
  }

  const outDir = path.resolve(args.out || path.join(path.dirname(src), path.parse(src).name + '_look'))
  fs.mkdirSync(outDir, { recursive: true })
  const size = args.size || '1600x900'

  log(`ffmpeg  : ${ff}`)
  log(`output  : ${outDir}`)

  const spec = path.join(outDir, 'spectrum.png')
  const wave = path.join(outDir, 'waveform.png')

  const st1 = run(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src,
    '-lavfi', `showspectrumpic=s=${size}:legend=1:scale=log`, '-frames:v', '1', spec])
  log(`  spectrum: ${st1 === 0 ? spec : 'FAILED'}`)

  const st2 = run(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src,
    '-lavfi', `showwavespic=s=${size}:split_channels=0:colors=#4a7ebb`, '-frames:v', '1', wave])
  log(`  waveform: ${st2 === 0 ? wave : 'FAILED'}`)

  if (st1 !== 0 && st2 !== 0) return 1
  log('\nquick look done. for lyrics / key / tempo / numbers, run:  music-lens analyze "<same file>"')
  return 0
}

async function cmdSeparate(args) {
  const audio = args._[0]
  if (!audio) die('usage: music-lens separate <audio> [--out DIR]')
  const py = findPython() || die('python not found -- run `music-lens setup`')
  const outDir = path.resolve(args.out || path.join(path.dirname(path.resolve(audio)), 'stems'))
  log(`separating -> ${outDir}`)
  const st = run(py, ['-m', 'demucs', '--two-stems=vocals', '-n', args.model || 'htdemucs',
    '-o', outDir, path.resolve(audio)])
  if (st === 0) log(`\nvocal stem: ${path.join(outDir, 'htdemucs', path.parse(audio).name, 'vocals.wav')}`)
  return st
}

function usage() {
  log(`music-lens ${JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version}

  music-lens doctor                        check environment
  music-lens setup [--models small]         install python deps + models
  music-lens analyze <audio>               transcribe + analyse
              [--model medium]             small | medium | large-v3 | path
              [--lang auto]                language code or auto
              [--out DIR]                  output directory
  music-lens spectrogram <audio>           quick look: spectrum + waveform (ffmpeg only,
              [--size 1600x900]            no python, no models, ~10 seconds)
  music-lens separate <audio>              split vocals / instrumental (demucs)

Outputs per song: 00_summary.md, 01_lyrics.txt, 02_transcript.json,
03_features.csv, 04_energy.png, 05_summary.json`)
}

const argv = process.argv.slice(2)
const args = parseArgs(argv)
const cmd = args._.shift() || 'help'

const map = {
  doctor: cmdDoctor,
  setup: cmdSetup,
  analyze: cmdAnalyze,
  separate: cmdSeparate,
  spectrogram: cmdSpectrogram,
 }

if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); process.exit(0) }
if (!map[cmd]) { usage(); die(`unknown command: ${cmd}`) }

Promise.resolve(map[cmd](args))
  .then(code => process.exit(code || 0))
  .catch(e => die(e?.message || String(e)))
