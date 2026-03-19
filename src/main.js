import './style.css'
import { createScene } from './scene.js'
import { ReplayPlayer } from './replayPlayer.js'

const canvas = document.getElementById('renderCanvas')
let engine, scene, xrHelper
try {
  ;({ engine, scene, xrHelper } = await createScene(canvas))
} catch (err) {
  console.error('Scene creation failed:', err)
  document.body.innerHTML = `<div style="color:red;padding:20px;font-family:monospace">Scene error: ${err.message}</div>`
  throw err
}

const player = new ReplayPlayer(scene)

// ── Timeline UI ───────────────────────────────────────────────────────────────
const tlBar = document.createElement('div')
tlBar.id = 'tl-bar'
tlBar.innerHTML = `
  <div id="tl-left">
    <button id="prev-event-btn" title="Previous goal/save">⏮</button>
    <button id="back5-btn" title="Back 5s">−5s</button>
    <button id="play-btn">▶</button>
    <button id="fwd5-btn" title="Forward 5s">+5s</button>
    <button id="next-event-btn" title="Next goal/save">⏭</button>
    <span id="tl-time">0:00</span>
  </div>
  <div id="tl-center">
    <div id="tl-events"></div>
    <div id="tl-track">
      <div id="tl-fill"></div>
      <div id="tl-scrubber"></div>
    </div>
  </div>
  <div id="tl-right">
    <span id="tl-duration">0:00</span>
    <button id="speed-btn">1×</button>
    <button id="upload-btn" title="Open .replay file">📂</button>
    <button id="vr-btn">VR</button>
  </div>
`
document.body.appendChild(tlBar)

function fmt(s) {
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60).toString().padStart(2, '0')
  return `${m}:${ss}`
}

// Play/pause toggle
const playBtn = document.getElementById('play-btn')
playBtn.onclick = () => {
  if (player.playing) { player.pause(); playBtn.textContent = '▶' }
  else                { player.play();  playBtn.textContent = '⏸' }
}
playBtn.textContent = '⏸'  // starts playing automatically

// Speed control
const SPEEDS = [0.25, 0.5, 1, 1.25, 1.5, 2]
let speedIdx = SPEEDS.indexOf(1)
const speedBtn = document.getElementById('speed-btn')
speedBtn.onclick = () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length
  player.speed = SPEEDS[speedIdx]
  const s = SPEEDS[speedIdx]
  speedBtn.textContent = `${s}×`
}

// Skip ±5 s
document.getElementById('back5-btn').onclick = () => player.seekTo(player.currentTime - 5)
document.getElementById('fwd5-btn').onclick  = () => player.seekTo(player.currentTime + 5)

// Prev / next event
document.getElementById('prev-event-btn').onclick = () => player.seekPrevEvent()
document.getElementById('next-event-btn').onclick = () => player.seekNextEvent()

// Upload .replay file
const fileInput = document.createElement('input')
fileInput.type = 'file'
fileInput.accept = '.replay'
fileInput.style.display = 'none'
document.body.appendChild(fileInput)

const uploadBtn = document.getElementById('upload-btn')
uploadBtn.onclick = () => fileInput.click()

fileInput.onchange = async () => {
  const file = fileInput.files[0]
  if (!file) return
  fileInput.value = ''

  uploadBtn.disabled = true
  uploadBtn.textContent = '⏳'

  try {
    const res = await fetch('/parse-replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await file.arrayBuffer(),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Parse failed')
    player._processReplayData(json)
  } catch (err) {
    alert('Failed to load replay: ' + err.message)
  } finally {
    uploadBtn.disabled = false
    uploadBtn.textContent = '📂'
  }
}

// VR button
document.getElementById('vr-btn').onclick = async () => {
  if (xrHelper) await xrHelper.baseExperience.enterXRAsync('immersive-vr', 'local-floor')
  else alert('WebXR not available in this browser.')
}

// Y button (left controller) → toggle VR replay controls panel
if (xrHelper) {
  xrHelper.input.onControllerAddedObservable.add(controller => {
    controller.onMotionControllerInitObservable.add(mc => {
      if (mc.handedness !== 'left') return
      const yBtn = mc.getComponent('y-button')
      if (!yBtn) return
      yBtn.onButtonStateChangedObservable.add(comp => {
        if (comp.pressed) player.toggleVRPanel()
      })
    })
  })
}

// ── Timeline scrubbing ────────────────────────────────────────────────────────
const track = document.getElementById('tl-track')
let scrubbing = false

function seekFromEvent(e) {
  const rect = track.getBoundingClientRect()
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const duration = player.frames[player.frames.length - 1]?.time ?? 1
  player.seekTo(pct * duration)
}

track.addEventListener('mousedown', e => { scrubbing = true; seekFromEvent(e) })
window.addEventListener('mousemove', e => { if (scrubbing) seekFromEvent(e) })
window.addEventListener('mouseup',   () => { scrubbing = false })

// ── Goal icons ────────────────────────────────────────────────────────────────
function buildGoalIcons(goals, duration) {
  const container = document.getElementById('tl-events')
  container.innerHTML = ''
  for (const g of goals) {
    const pct = duration > 0 ? (g.time / duration) * 100 : 0
    const icon = document.createElement('div')
    icon.className = `tl-event tl-goal team-${g.team}`
    icon.title = `Goal – ${g.player_name}`
    icon.style.left = `${pct}%`
    container.appendChild(icon)
  }
}

// Called by ReplayPlayer once the replay JSON has fully loaded
player.onMetaLoad = () => {
  const duration = player.frames[player.frames.length - 1]?.time ?? 0
  document.getElementById('tl-duration').textContent = fmt(duration)
  if (player.meta?.goals) buildGoalIcons(player.meta.goals, duration)
}

// ── Render loop ───────────────────────────────────────────────────────────────
engine.runRenderLoop(() => {
  player.update(engine.getDeltaTime() / 1000)

  const duration = player.frames[player.frames.length - 1]?.time ?? 1
  const pct = duration > 0 ? (player.currentTime / duration) * 100 : 0
  document.getElementById('tl-fill').style.width = `${pct}%`
  document.getElementById('tl-scrubber').style.left = `${pct}%`
  document.getElementById('tl-time').textContent = fmt(player.currentTime)

  scene.render()
})

window.addEventListener('resize', () => engine.resize())
