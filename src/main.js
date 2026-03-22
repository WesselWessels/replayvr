import './style.css'
import { createScene } from './scene.js'
import { ReplayPlayer } from './replayPlayer.js'
import { parse_replay } from './wasm/rl_parser.js'

const canvas = document.getElementById('renderCanvas')
let engine, scene, xrHelper, arSupported
try {
  ;({ engine, scene, xrHelper, arSupported } = await createScene(canvas))
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
    <button id="mute-btn" title="Mute/unmute audio">🔊</button>
    <button id="upload-btn" title="Open .replay file">📂</button>
    <button id="about-btn" title="About">?</button>
    <button id="ar-btn">AR</button>
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

// About modal
const aboutModal = document.createElement('div')
aboutModal.id = 'about-modal'
aboutModal.innerHTML = `
  <div id="about-box">
    <button id="about-close">✕</button>
    <h2>RL Replay Viewer</h2>
    <p>A browser-based 3D viewer for Rocket League replay files (<code>.replay</code>). Supports desktop and WebXR (AR/VR headsets).</p>

    <h3>How to use</h3>
    <ul>
      <li>Click <strong>📂</strong> to load a <code>.replay</code> file from your device.</li>
      <li>Use the timeline to scrub, skip ±5 s, or jump between goals.</li>
      <li>Adjust playback speed with the <strong>1×</strong> button.</li>
      <li>Click <strong>AR</strong> or <strong>VR</strong> to enter immersive mode (WebXR device required).</li>
    </ul>

    <h3>VR / AR Controls</h3>
    <ul>
      <li><strong>Y</strong> — toggle replay panel</li>
      <li><strong>X</strong> — play / pause</li>
      <li><strong>A (hold)</strong> — rewind 4×</li>
      <li><strong>B (hold)</strong> — fast-forward 4×</li>
      <li><strong>Left stick</strong> — move / strafe (free cam) or adjust camera offset (car cam)</li>
      <li><strong>Right stick</strong> — rotate yaw / orbit car</li>
      <li><strong>Grips</strong> — move up/down (free cam) or scale/rotate miniature (AR, both grips)</li>
    </ul>

    <h3>Credits</h3>
    <ul>
      <li>
        <strong>Octane car model</strong> —
        <a href="https://sketchfab.com/3d-models/octane-rocket-league-car-9910f0a5d158425bbc7deb60c7a81f69" target="_blank" rel="noopener">
          Octane - Rocket League Car
        </a>
        by <a href="https://sketchfab.com/fairlight51" target="_blank" rel="noopener">Jako (fairlight51)</a>,
        licensed under <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>.
      </li>
      <li><strong>Replay parser</strong> — built on <a href="https://github.com/nickbabcock/boxcars" target="_blank" rel="noopener">boxcars</a> (Rust / WASM).</li>
      <li><strong>3D engine</strong> — <a href="https://www.babylonjs.com/" target="_blank" rel="noopener">Babylon.js</a>.</li>
    </ul>
  </div>
`
document.body.appendChild(aboutModal)

document.getElementById('about-btn').onclick  = () => { aboutModal.style.display = 'flex' }
document.getElementById('about-close').onclick = () => { aboutModal.style.display = 'none' }
aboutModal.addEventListener('click', e => { if (e.target === aboutModal) aboutModal.style.display = 'none' })

const muteBtn = document.getElementById('mute-btn')
muteBtn.onclick = () => {
  const nowMuted = player.toggleMute()
  muteBtn.textContent = nowMuted ? '🔇' : '🔊'
  if (player._vrMuteLbl) player._vrMuteLbl.text = nowMuted ? '\uD83D\uDD07' : '\uD83D\uDD0A'
}

const uploadBtn = document.getElementById('upload-btn')
uploadBtn.onclick = () => fileInput.click()

fileInput.onchange = async () => {
  const file = fileInput.files[0]
  if (!file) return
  fileInput.value = ''

  uploadBtn.disabled = true
  uploadBtn.textContent = '⏳'

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const jsonStr = parse_replay(bytes)
    player._processReplayData(JSON.parse(jsonStr))
  } catch (err) {
    alert('Failed to load replay: ' + err.message)
  } finally {
    uploadBtn.disabled = false
    uploadBtn.textContent = '📂'
  }
}

// AR button — enters immersive-ar passthrough on the existing XR experience
const arBtn = document.getElementById('ar-btn')
let _inAR = false
arBtn.onclick = async () => {
  if (!arSupported || !xrHelper) { alert('AR not supported on this device.'); return }
  if (!_inAR) {
    // Signal AR mode BEFORE entering XR so onInitialXRPoseSetObservable skips the VR offset
    scene._playerArMode = true
    await xrHelper.baseExperience.enterXRAsync('immersive-ar', 'local-floor')
    player.enterAR()
    _inAR = true
    arBtn.textContent = 'Exit AR'
  } else {
    scene._playerArMode = false
    player.exitAR()
    await xrHelper.baseExperience.exitXRAsync()
    _inAR = false
    arBtn.textContent = 'AR'
  }
}

// VR button
document.getElementById('vr-btn').onclick = async () => {
  if (_inAR) return  // don't allow VR while in AR
  if (xrHelper) await xrHelper.baseExperience.enterXRAsync('immersive-vr', 'local-floor')
  else alert('WebXR not available in this browser.')
}

// In-headset Exit XR button — handles both AR and VR
player.onExitXR = async () => {
  if (_inAR) {
    scene._playerArMode = false
    player.exitAR()
    await xrHelper.baseExperience.exitXRAsync()
    _inAR = false
    arBtn.textContent = 'AR'
  } else if (xrHelper) {
    await xrHelper.baseExperience.exitXRAsync()
    player.resetToFreeCam()
  }
}

// Y button (left controller) → toggle VR replay controls panel
if (xrHelper) {
  xrHelper.input.onControllerAddedObservable.add(controller => {
    controller.onMotionControllerInitObservable.add(mc => {
      if (mc.handedness !== 'left') return
      const yBtn = mc.getComponent('y-button')
      if (yBtn) yBtn.onButtonStateChangedObservable.add(comp => {
        if (comp.pressed) player.toggleVRPanel()
      })
      const xBtn = mc.getComponent('x-button')
      if (xBtn) xBtn.onButtonStateChangedObservable.add(comp => {
        if (!comp.pressed) return
        if (player.playing) { player.pause(); playBtn.textContent = '▶' }
        else                { player.play();  playBtn.textContent = '⏸' }
      })
    })
  })
}

// A button (right controller) → rewind 4×, B button → fast forward 4×
if (xrHelper) {
  xrHelper.input.onControllerAddedObservable.add(controller => {
    controller.onMotionControllerInitObservable.add(mc => {
      if (mc.handedness !== 'right') return
      const aBtn = mc.getComponent('a-button')
      const bBtn = mc.getComponent('b-button')
      if (aBtn) aBtn.onButtonStateChangedObservable.add(comp => { scene._aHeld = comp.pressed })
      if (bBtn) bBtn.onButtonStateChangedObservable.add(comp => { scene._bHeld = comp.pressed })
    })
  })
  scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000
    const scrubSpeed = player.playing ? 4 : 0.25
    if (scene._bHeld) player.seekTo(player.currentTime + dt * scrubSpeed)
    if (scene._aHeld) player.seekTo(player.currentTime - dt * scrubSpeed)
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
