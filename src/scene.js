import {
  Engine,
  Scene,
  HemisphericLight,
  DirectionalLight,
  ArcRotateCamera,
  Vector3,
  Quaternion,
  WebXRDefaultExperience,
  WebXRSessionManager,
  WebXRFeatureName,
  Color3,
  Color4,
} from '@babylonjs/core'

export async function createScene(canvas) {
  const engine = new Engine(canvas, true, { adaptToDeviceRatio: true })
  const scene = new Scene(engine)
  scene.clearColor = new Color4(0.05, 0.05, 0.1, 1)

  // Lighting
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
  hemi.intensity = 0.4
  hemi.groundColor = new Color3(0.1, 0.1, 0.2)

  const sun = new DirectionalLight('sun', new Vector3(-1, -2, -1), scene)
  sun.intensity = 0.8

  // Desktop camera — always created first so there's always an active camera
  // Start outside the field on the halfway line at ~45 degrees elevation
  // alpha=0 puts camera on the +X side; beta=PI/4 is 45 degrees; radius=155 clears the side wall
  const camera = new ArcRotateCamera('cam', 0, Math.PI / 4, 155, new Vector3(0, 0, 0), scene)
  camera.lowerRadiusLimit = 10
  camera.upperRadiusLimit = 300
  camera.attachControl(canvas, true)
  // Remove mouse-drag orbit — replaced by pointer-lock look control below
  camera.inputs.removeByType('ArcRotateCameraPointersInput')

  // Pointer lock: click canvas to capture mouse, Escape to release
  canvas.addEventListener('click', () => canvas.requestPointerLock())
  canvas.addEventListener('contextmenu', e => e.preventDefault())
  canvas.addEventListener('mousedown',   e => { if (e.button === 2) document.exitPointerLock() })
  const LOOK_SENS = 0.003
  window.addEventListener('mousemove', e => {
    if (document.pointerLockElement !== canvas) return
    if (scene.activeCamera !== camera) return
    camera.alpha -= e.movementX * LOOK_SENS
    camera.beta  = Math.max(0.05, Math.min(Math.PI - 0.05, camera.beta - e.movementY * LOOK_SENS))
  })

  // WASD + Space/Shift desktop camera movement
  const keys = {}
  window.addEventListener('keydown', e => { keys[e.code] = true })
  window.addEventListener('keyup',   e => { keys[e.code] = false })

  const MOVE_SPEED = 0.8
  scene.onBeforeRenderObservable.add(() => {
    if (scene.activeCamera !== camera) return   // don't interfere in XR

    const any = keys['KeyW'] || keys['KeyS'] || keys['KeyA'] || keys['KeyD'] ||
                keys['Space'] || keys['ShiftLeft'] || keys['ShiftRight']
    if (!any) return

    // Horizontal forward = direction from camera to target, flattened to XZ
    const toTarget = camera.target.subtract(camera.position)
    const fwd = new Vector3(toTarget.x, 0, toTarget.z)
    if (fwd.lengthSquared() > 0.001) fwd.normalize()
    const right = Vector3.Cross(fwd, Vector3.Up()).normalize()

    const delta = new Vector3(0, 0, 0)
    if (keys['KeyW'])                                  delta.addInPlace(fwd)
    if (keys['KeyS'])                                  delta.subtractInPlace(fwd)
    if (keys['KeyA'])                                  delta.addInPlace(right)
    if (keys['KeyD'])                                  delta.subtractInPlace(right)
    if (keys['Space'])                                 delta.y += 1
    if (keys['ShiftLeft'] || keys['ShiftRight'])       delta.y -= 1

    camera.target.addInPlace(delta.scaleInPlace(MOVE_SPEED))
  })

  // WebXR — only attempt if the browser advertises support
  let xrHelper = null
  const xrSupported = await WebXRSessionManager.IsSessionSupportedAsync('immersive-vr')
  if (xrSupported) {
    try {
      xrHelper = await WebXRDefaultExperience.CreateAsync(scene, {
        floorMeshes: [],
        disableTeleportation: true,
      })

      // Enable hand tracking explicitly so we can set hideHandMeshesWithController.
      // Without this the hand meshes freeze in place when you pick up controllers.
      try {
        xrHelper.baseExperience.featuresManager.enableFeature(
          WebXRFeatureName.HAND_TRACKING,
          'latest',
          {
            xrInput: xrHelper.input,
            jointMeshes: { hideHandMeshesWithController: true },
          },
        )
      } catch (e) {
        console.info('Hand tracking not available:', e.message)
      }
      xrHelper.baseExperience.onInitialXRPoseSetObservable.add((xrCamera) => {
        // In AR the rig must stay at world origin so the arena overlay aligns
        // with the real world. Only apply the VR fly-in offset.
        if (!scene._playerArMode) xrCamera.position = new Vector3(110, 110, 0)
      })

      // Manual thumbstick control: left stick = move, right stick = rotate
      const axes = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } }
      const DEAD = 0.12, MOVE_SPD = 0.35, ROT_SPD = 0.035, CAR_SPD = 0.05

      // Default car-cam offset (relative to followed car); right-stick-click resets to these
      const CAR_CAM_DEFAULT = { fwd: -4, side: 0, up: 1 }
      scene._carCamOff = { ...CAR_CAM_DEFAULT }
      scene._carCamYaw = 0

      // Cache squeeze (grip) components per hand so we don't call getComponentOfType every frame
      const squeezeCmps = {}
      xrHelper.input.onControllerAddedObservable.add(controller => {
        controller.onMotionControllerInitObservable.add(mc => {
          const hand = mc.handedness === 'left' ? 'left' : 'right'
          const stick = mc.getComponentOfType('thumbstick') ?? mc.getComponentOfType('touchpad')
          if (stick) {
            stick.onAxisValueChangedObservable.add(({ x, y }) => { axes[hand] = { x, y } })
            if (hand === 'right') {
              stick.onButtonStateChangedObservable.add(comp => {
                if (comp.pressed) scene._carCamReset = true
              })
            }
          }
          const squeeze = mc.getComponentOfType('squeeze')
          if (squeeze) squeezeCmps[hand] = squeeze
        })
      })

      scene.onBeforeRenderObservable.add(() => {
        const cam = xrHelper.baseExperience.camera
        if (!cam) return

        // Hide frozen hand meshes whenever physical controllers are active
        if (xrHelper.input.controllers.length > 0) {
          scene.meshes.forEach(m => {
            if (m.name.includes('-hand-joint-') || m.name.includes('xr-hand')) {
              m.isVisible = false
            }
          })
        }

        // In ball/car cam the player code owns the camera position — skip left-stick translation
        // Also skip all joystick locomotion in AR mode (grip gestures move the arena instead)
        const camMode = scene._playerCamMode
        const { x: lx, y: ly } = axes.left
        const { x: rx } = axes.right

        // Reset car-cam offset on right thumbstick click
        if (scene._carCamReset) {
          scene._carCamReset = false
          scene._carCamOff = { ...CAR_CAM_DEFAULT }
          scene._carCamYaw = 0
        }

        if (!scene._arenaRoot) {
          if (camMode === 'car') {
            // Car cam: left stick adjusts offset (fwd/back, strafe); right stick orbits
            if (Math.abs(lx) > DEAD) scene._carCamOff.side += lx * CAR_SPD
            if (Math.abs(ly) > DEAD) scene._carCamOff.fwd  -= ly * CAR_SPD
            if (Math.abs(rx) > DEAD) scene._carCamYaw       += rx * ROT_SPD
          } else {
            // Free cam + ball cam: left stick moves (free only), right stick rotates
            if (camMode !== 'ball' && (Math.abs(lx) > DEAD || Math.abs(ly) > DEAD)) {
              const fwd = cam.getDirection(Vector3.Forward())
              fwd.y = 0
              if (fwd.lengthSquared() > 0.001) fwd.normalize()
              const right = cam.getDirection(Vector3.Right())
              right.y = 0
              if (right.lengthSquared() > 0.001) right.normalize()
              cam.position.addInPlace(fwd.scaleInPlace(-ly * MOVE_SPD))
                          .addInPlace(right.scaleInPlace(lx * MOVE_SPD))
            }
            if (Math.abs(rx) > DEAD) {
              const q = cam.rotationQuaternion
              if (q) {
                const delta = Quaternion.RotationAxis(Vector3.Up(), rx * ROT_SPD)
                cam.rotationQuaternion = delta.multiply(q)
              } else {
                cam.rotation.y += rx * ROT_SPD
              }
            }
          }
        }

        // AR grip gestures: both grips = scale + rotate, one grip = translate
        if (scene._arenaRoot) {
          const lHeld = (squeezeCmps.left?.value  ?? 0) > 0.5
          const rHeld = (squeezeCmps.right?.value ?? 0) > 0.5
          const lc = xrHelper.input.controllers.find(c => c.inputSource.handedness === 'left')
          const rc = xrHelper.input.controllers.find(c => c.inputSource.handedness === 'right')

          if (lHeld && rHeld && lc?.grip && rc?.grip) {
            // Both grips: scale (apart/together) + rotate (twist like a steering wheel)
            const lp = lc.grip.position, rp = rc.grip.position
            const dist  = Vector3.Distance(lp, rp)
            const angle = Math.atan2(rp.x - lp.x, rp.z - lp.z)
            if (!scene._gripRef || scene._gripRef.mode !== 'two') {
              scene._gripRef = { mode: 'two', dist, angle,
                scale: scene._arenaRoot.scaling.x,
                rotY:  scene._arenaRoot.rotation.y }
            } else if (dist > 0.02) {
              scene._arenaRoot.scaling.setAll(
                Math.max(0.0005, scene._gripRef.scale * (dist / scene._gripRef.dist)))
              let dAngle = angle - scene._gripRef.angle
              if (dAngle >  Math.PI) dAngle -= 2 * Math.PI
              if (dAngle < -Math.PI) dAngle += 2 * Math.PI
              scene._arenaRoot.rotation.y = scene._gripRef.rotY + dAngle
            }
          } else if (lHeld && lc?.grip) {
            // Left grip only: translate arena
            const cur = lc.grip.position
            if (scene._gripRef?.mode === 'left') {
              const p = scene._gripRef.pos
              scene._arenaRoot.position.x += cur.x - p.x
              scene._arenaRoot.position.y += cur.y - p.y
              scene._arenaRoot.position.z += cur.z - p.z
            }
            scene._gripRef = { mode: 'left', pos: cur.clone() }
          } else if (rHeld && rc?.grip) {
            // Right grip only: translate arena
            const cur = rc.grip.position
            if (scene._gripRef?.mode === 'right') {
              const p = scene._gripRef.pos
              scene._arenaRoot.position.x += cur.x - p.x
              scene._arenaRoot.position.y += cur.y - p.y
              scene._arenaRoot.position.z += cur.z - p.z
            }
            scene._gripRef = { mode: 'right', pos: cur.clone() }
          } else {
            scene._gripRef = null
          }
        } else {
          // VR mode: left grip = move down, right grip = move up
          const lHeld = (squeezeCmps.left?.value  ?? 0) > 0.5
          const rHeld = (squeezeCmps.right?.value ?? 0) > 0.5
          if (camMode === 'car') {
            if (lHeld) scene._carCamOff.up -= CAR_SPD
            if (rHeld) scene._carCamOff.up += CAR_SPD
          } else {
            if (lHeld) cam.position.y -= MOVE_SPD
            if (rHeld) cam.position.y += MOVE_SPD
          }
        }
      })
    } catch (err) {
      console.warn('WebXR setup failed:', err)
    }
  } else {
    console.info('WebXR immersive-vr not supported — desktop mode.')
  }

  const arSupported = await WebXRSessionManager.IsSessionSupportedAsync('immersive-ar')

  return { engine, scene, xrHelper, arSupported }
}
