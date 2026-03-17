import {
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  ArcRotateCamera,
} from '@babylonjs/core'
import { buildArena, UU_SCALE, ARENA } from './arena.js'

const TEAM_COLORS = {
  0: new Color3(0.1, 0.3, 1.0),   // blue
  1: new Color3(1.0, 0.4, 0.05),  // orange
}

export class ReplayPlayer {
  constructor(scene) {
    this.scene = scene
    this.frames = []
    this.currentTime = 0
    this.playing = false
    this._frameIndex = 0

    buildArena(scene)
    this._setupCamera()

    // Placeholder meshes — replaced when a replay is loaded
    this._ball = this._makeBall()
    this._carMeshes = []

    // Load demo data so something moves on screen immediately
    this._loadDemoFrames()
  }

  _setupCamera() {
    const cam = new ArcRotateCamera(
      'cam',
      -Math.PI / 2,
      Math.PI / 3,
      60,
      new Vector3(0, 5, 0),
      this.scene,
    )
    cam.lowerRadiusLimit = 10
    cam.upperRadiusLimit = 120
    cam.attachControl(this.scene.getEngine().getRenderingCanvas(), true)
    this._camera = cam
  }

  _makeBall() {
    const ball = MeshBuilder.CreateSphere('ball', { diameter: 1.0 * UU_SCALE * 100 }, this.scene)
    const mat = new StandardMaterial('ballMat', this.scene)
    mat.diffuseColor = new Color3(1, 1, 1)
    ball.material = mat
    return ball
  }

  _makeCar(id, team) {
    const car = MeshBuilder.CreateBox(`car_${id}`, {
      width: 1.28,
      height: 0.56,
      depth: 1.92,
    }, this.scene)
    const mat = new StandardMaterial(`carMat_${id}`, this.scene)
    mat.diffuseColor = TEAM_COLORS[team] ?? new Color3(0.5, 0.5, 0.5)
    car.material = mat
    return car
  }

  // Load a parsed replay (array of frame objects)
  // Each frame: { time, ball: {x,y,z}, cars: [{id, team, x,y,z,yaw}] }
  loadReplay(frames) {
    this.frames = frames
    this.currentTime = 0
    this._frameIndex = 0
    this.playing = false

    // Rebuild car meshes to match player count in replay
    for (const mesh of this._carMeshes) mesh.dispose()
    this._carMeshes = {}

    const firstFrame = frames[0]
    if (firstFrame) {
      for (const car of firstFrame.cars) {
        this._carMeshes[car.id] = this._makeCar(car.id, car.team)
      }
    }
  }

  _loadDemoFrames() {
    // Two cars doing laps + ball bouncing — just to prove the scene works
    const frames = []
    const duration = 10
    const fps = 30
    for (let i = 0; i <= duration * fps; i++) {
      const t = i / fps
      const angle = t * 0.8
      frames.push({
        time: t,
        ball: {
          x: Math.sin(t * 1.5) * ARENA.halfX * 0.5,
          y: Math.abs(Math.sin(t * 2.5)) * 8 + 1,
          z: Math.cos(t * 1.2) * ARENA.halfY * 0.5,
        },
        cars: [
          {
            id: 'blue1', team: 0,
            x: Math.cos(angle) * ARENA.halfX * 0.6,
            y: 0.3,
            z: Math.sin(angle) * ARENA.halfY * 0.6,
            yaw: angle + Math.PI / 2,
          },
          {
            id: 'orange1', team: 1,
            x: Math.cos(angle + Math.PI) * ARENA.halfX * 0.6,
            y: 0.3,
            z: Math.sin(angle + Math.PI) * ARENA.halfY * 0.6,
            yaw: angle + Math.PI + Math.PI / 2,
          },
        ],
      })
    }

    this.loadReplay(frames)
    this.play()
  }

  play()  { this.playing = true }
  pause() { this.playing = false }

  update(dt) {
    if (!this.playing || this.frames.length === 0) return

    this.currentTime += dt

    // Loop replay
    const last = this.frames[this.frames.length - 1].time
    if (this.currentTime > last) this.currentTime = 0

    // Advance frame index
    while (
      this._frameIndex < this.frames.length - 2 &&
      this.frames[this._frameIndex + 1].time <= this.currentTime
    ) {
      this._frameIndex++
    }

    const frameA = this.frames[this._frameIndex]
    const frameB = this.frames[Math.min(this._frameIndex + 1, this.frames.length - 1)]
    const span = frameB.time - frameA.time
    const alpha = span > 0 ? (this.currentTime - frameA.time) / span : 0

    // Interpolate ball
    this._ball.position = Vector3.Lerp(
      new Vector3(frameA.ball.x, frameA.ball.y, frameA.ball.z),
      new Vector3(frameB.ball.x, frameB.ball.y, frameB.ball.z),
      alpha,
    )

    // Interpolate cars
    for (const carA of frameA.cars) {
      const carB = frameB.cars.find(c => c.id === carA.id)
      const mesh = this._carMeshes[carA.id]
      if (!mesh || !carB) continue
      mesh.position = Vector3.Lerp(
        new Vector3(carA.x, carA.y, carA.z),
        new Vector3(carB.x, carB.y, carB.z),
        alpha,
      )
      mesh.rotation.y = carA.yaw + (carB.yaw - carA.yaw) * alpha
    }
  }
}
