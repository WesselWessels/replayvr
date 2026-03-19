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
        xrCamera.position = new Vector3(110, 110, 0)
      })

      // Manual thumbstick control: left stick = move, right stick = rotate
      const axes = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } }
      const DEAD = 0.12, MOVE_SPD = 0.35, ROT_SPD = 0.035

      xrHelper.input.onControllerAddedObservable.add(controller => {
        controller.onMotionControllerInitObservable.add(mc => {
          const stick = mc.getComponentOfType('thumbstick') ?? mc.getComponentOfType('touchpad')
          if (!stick) return
          stick.onAxisValueChangedObservable.add(({ x, y }) => {
            axes[mc.handedness === 'left' ? 'left' : 'right'] = { x, y }
          })
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

        const { x: lx, y: ly } = axes.left
        const { x: rx } = axes.right
        if (Math.abs(lx) > DEAD || Math.abs(ly) > DEAD) {
          const fwd = cam.getDirection(Vector3.Forward()).scaleInPlace(-ly * MOVE_SPD)
          const right = cam.getDirection(Vector3.Right()).scaleInPlace(lx * MOVE_SPD)
          cam.position.addInPlace(fwd).addInPlace(right)
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
      })
    } catch (err) {
      console.warn('WebXR setup failed:', err)
    }
  } else {
    console.info('WebXR immersive-vr not supported — desktop mode.')
  }

  return { engine, scene, xrHelper }
}
