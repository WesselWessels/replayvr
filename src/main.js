import './style.css'
import { createScene } from './scene.js'
import { ReplayPlayer } from './replayPlayer.js'

const canvas = document.getElementById('renderCanvas')
const { engine, scene, xrHelper } = await createScene(canvas)

const player = new ReplayPlayer(scene)

// UI
const ui = document.createElement('div')
ui.id = 'ui-overlay'
ui.innerHTML = `
  <button id="play-btn">▶ Play</button>
  <button id="pause-btn">⏸ Pause</button>
  <span id="time-display">0.00s</span>
  <button id="vr-button">Enter VR</button>
`
document.body.appendChild(ui)

document.getElementById('play-btn').onclick = () => player.play()
document.getElementById('pause-btn').onclick = () => player.pause()
document.getElementById('vr-button').onclick = async () => {
  if (xrHelper) {
    await xrHelper.baseExperience.enterXRAsync('immersive-vr', 'local-floor')
  } else {
    alert('WebXR not available in this browser.')
  }
}

engine.runRenderLoop(() => {
  player.update(engine.getDeltaTime() / 1000)
  const t = player.currentTime.toFixed(2)
  document.getElementById('time-display').textContent = `${t}s`
  scene.render()
})

window.addEventListener('resize', () => engine.resize())
