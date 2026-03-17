import {
  Engine,
  Scene,
  HemisphericLight,
  DirectionalLight,
  Vector3,
  WebXRDefaultExperience,
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

  // WebXR — gracefully degrade if not supported
  let xrHelper = null
  try {
    xrHelper = await WebXRDefaultExperience.CreateAsync(scene, {
      floorMeshes: [],
      disableTeleportation: true,
      optionalFeatures: true,
    })
    // Start in a good stadium-spectator position
    xrHelper.baseExperience.onInitialXRPoseSetObservable.add((xrCamera) => {
      xrCamera.position = new Vector3(0, 5, -30)
    })
  } catch {
    console.warn('WebXR not available — running in desktop mode.')
  }

  return { engine, scene, xrHelper }
}
