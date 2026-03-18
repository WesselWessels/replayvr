import {
  Engine,
  Scene,
  HemisphericLight,
  DirectionalLight,
  ArcRotateCamera,
  Vector3,
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
  const camera = new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 3, 80, new Vector3(0, 5, 0), scene)
  camera.lowerRadiusLimit = 10
  camera.upperRadiusLimit = 150
  camera.attachControl(canvas, true)

  // WebXR — only attempt if the browser advertises support
  let xrHelper = null
  const xrSupported = await WebXRSessionManager.IsSessionSupportedAsync('immersive-vr')
  if (xrSupported) {
    try {
      xrHelper = await WebXRDefaultExperience.CreateAsync(scene, {
        floorMeshes: [],
        disableTeleportation: true,
        optionalFeatures: true,
      })
      xrHelper.baseExperience.onInitialXRPoseSetObservable.add((xrCamera) => {
        xrCamera.position = new Vector3(0, 5, -30)
      })

      xrHelper.baseExperience.featuresManager.enableFeature(
        WebXRFeatureName.MOVEMENT,
        'latest',
        {
          xrInput: xrHelper.input,
          movementOrientationFollowsViewerPose: true,
          movementSpeed: 0.5,
          rotationSpeed: 0.25,
        },
      )
    } catch (err) {
      console.warn('WebXR setup failed:', err)
    }
  } else {
    console.info('WebXR immersive-vr not supported — desktop mode.')
  }

  return { engine, scene, xrHelper }
}
