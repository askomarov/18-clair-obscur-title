import * as THREE from "three/webgpu";
import { Inspector } from "three/addons/inspector/Inspector.js";
import { bloom } from "three/examples/jsm/tsl/display/BloomNode.js";
import {
  color,
  deltaTime,
  hash,
  If,
  instancedArray,
  instanceIndex,
  min,
  mix,
  mx_noise_vec3,
  normalLocal,
  pass,
  positionLocal,
  range,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { Fn } from "three/tsl";
import { randomSphericalPosition } from "./utils.js";
import { rotate } from "three/tsl";

/**
 * Base
 */
// Canvas
const canvas = document.querySelector("canvas.threejs");

// Scene
const scene = new THREE.Scene();

// Loading
const loaderElement = document.querySelector("#loader");
const loaderBar = document.querySelector(".loader__bar");
const loadingManager = new THREE.LoadingManager();

loadingManager.onProgress = (_url, loaded, total) => {
  if (!loaderBar || total === 0) return;
  loaderBar.style.width = `${(loaded / total) * 100}%`;
};

loadingManager.onLoad = () => {
  loaderElement?.classList.add("is-done");
};

// Texture loader
const textureLoader = new THREE.TextureLoader(loadingManager);

/**
 * Sizes
 */
const sizes = {
  width: window.innerWidth,
  height: window.innerHeight,
};

let updateTitleFit = () => {};

window.addEventListener("resize", () => {
  // Update sizes
  sizes.width = window.innerWidth;
  sizes.height = window.innerHeight;

  // Update camera
  camera.aspect = sizes.width / sizes.height;
  camera.updateProjectionMatrix();

  // Keep title fully visible (contain); particles stay height-driven via FOV
  updateTitleFit();

  // Update renderer
  renderer.setSize(sizes.width, sizes.height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

/**
 * Camera
 */
const camera = new THREE.PerspectiveCamera(
  35,
  sizes.width / sizes.height,
  0.1,
  100,
);
const cameraBase = new THREE.Vector3(0, 0, 4);
camera.position.copy(cameraBase);
camera.lookAt(0, 0, 0);
scene.add(camera);

// Parallax on mouse move
const parallaxStrength = 0.18;
const parallaxDamping = 0.04;
const parallaxTarget = new THREE.Vector3();
const lookAtTarget = new THREE.Vector3();
const cursorSmooth = new THREE.Vector2();
let pointerInside = false;

/**
 * Renderer
 */
const renderer = new THREE.WebGPURenderer({
  canvas: canvas,
  antialias: true,
});
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.CineonToneMapping;
renderer.toneMappingExposure = 1;
renderer.setSize(sizes.width, sizes.height);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x111111);
renderer.inspector = new Inspector();
await renderer.init();

/**
 * Post processing
 */
const renderPipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
const scenePassColor = scenePass.getTextureNode("output");
const bloomPass = bloom(scenePassColor);
bloomPass.threshold.value = 0.08;
bloomPass.strength.value = 1.32;

renderPipeline.outputNode = scenePassColor.add(bloomPass);

const bloomGui = renderer.inspector.createParameters("Bloom").close();
bloomGui.add(bloomPass.threshold, "value", 0, 2, 0.01).name("threshold");
bloomGui.add(bloomPass.strength, "value", 0, 2, 0.01).name("strength");

/**
 * Cursor
 */
const raycaster = new THREE.Raycaster();
const cursor = new THREE.Vector2();
const intersetionPlane = new THREE.Plane(
  new THREE.Vector3(0, 0, 1), // towards the camera
  0,
);
const intersect = new THREE.Vector3();
// const cursorHelper = new THREE.Mesh(
//   new THREE.IcosahedronGeometry(0.25, 3),
//   new THREE.MeshBasicMaterial({
//     color: 0xffff00,
//   }),
// );
// scene.add(cursorHelper);

//mouse move
window.addEventListener("pointermove", (event) => {
  pointerInside = true;
  cursor.x = (event.clientX / sizes.width) * 2 - 1;
  cursor.y = -(event.clientY / sizes.height) * 2 + 1;
});

document.documentElement.addEventListener("mouseleave", () => {
  pointerInside = false;
});

/**
 * Petals
 */
const count = 1000;
const ambientCount = 180; // always flying around the scene
const geometry = new THREE.SphereGeometry(
  1,
  3,
  3,
  Math.PI * 0.4,
  Math.PI * 0.2,
  Math.PI * 0.4,
  Math.PI * 0.2,
);
geometry.translate(0, 0, -1);

// textures — random petal / leaf variation per instance
const petalTexture = textureLoader.load("./petals-alpha-map.png");
const berezaTexture = textureLoader.load("./bereza.jpg");

// material
const material = new THREE.MeshLambertNodeMaterial({
  side: THREE.DoubleSide,
  //   transparent: true,
  alphaTest: 0.1,
});

const textureSelect = hash(instanceIndex.add(17)).step(0.5);
material.opacityNode = mix(
  texture(petalTexture, uv()).r,
  texture(berezaTexture, uv()).r,
  textureSelect,
);

// Uniforms
const scale = uniform(0.1);
const colorA = uniform(color(0xe00b9c));
const colorB = uniform(color(0x0a0e8f));
const radius = uniform(0.2);
const ambientRadius = uniform(1.4);
const windStrength = uniform(0.003);
const windFrequency = uniform(3);
const windVariation = uniform(0.3);
const spawnPosition = uniform(vec3(0));

const ambientSpawnPosition = Fn(([seed]) => {
  return vec3(
    hash(seed).sub(0.5).mul(ambientRadius).mul(2.2),
    hash(seed.add(1)).sub(0.5).mul(ambientRadius).mul(1.6),
    hash(seed.add(2)).sub(0.5).mul(ambientRadius).mul(0.8),
  );
});

// buffers
const scaleBuffer = range(0.5, 1);
const colorMixBuffer = range(0, 1);
const initialPostionsBuffer = instancedArray(count, "vec3");
const positionsBuffer = instancedArray(count, "vec3");
const progressesBuffer = instancedArray(count, "float");

// init compute
const initPetals = Fn(() => {
  const initialPosition = initialPostionsBuffer.element(instanceIndex);
  const position = positionsBuffer.element(instanceIndex);
  const progress = progressesBuffer.element(instanceIndex);
  const isAmbient = instanceIndex.lessThan(ambientCount);

  initialPosition.assign(randomSphericalPosition(instanceIndex, 1));
  progress.assign(hash(instanceIndex.mul(3)));

  If(isAmbient, () => {
    position.assign(ambientSpawnPosition(instanceIndex.add(7)));
  }).Else(() => {
    position.assign(initialPosition.mul(radius));
  });
})();

const initPetalsCompute = initPetals.compute(count);
renderer.compute(initPetalsCompute);

// update compute
const updatePetals = Fn(() => {
  const initialPosition = initialPostionsBuffer.element(instanceIndex);
  const position = positionsBuffer.element(instanceIndex);
  const progress = progressesBuffer.element(instanceIndex);
  const isAmbient = instanceIndex.lessThan(ambientCount);

  // ambient float a bit slower so they linger in the scene
  const lifeSpeed = isAmbient.select(0.25, 0.6);
  progress.addAssign(deltaTime.mul(lifeSpeed));
  If(progress.greaterThan(1), () => {
    progress.assign(progress.fract());
    If(isAmbient, () => {
      // respawn somewhere in the scene
      position.assign(
        ambientSpawnPosition(instanceIndex.add(time.mul(100).toUint())),
      );
    }).Else(() => {
      // when particle died add new one at cursor spawn position
      position.assign(initialPosition.mul(radius).add(spawnPosition));
    });
  });

  // position
  const wind = mx_noise_vec3(
    position.mul(windFrequency).add(time.mul(windVariation)),
  ).mul(windStrength);
  position.addAssign(wind);
})();
const updatePetalsCompute = updatePetals.compute(count);

// position
material.positionNode = Fn(() => {
  const progress = progressesBuffer.element(instanceIndex);
  const position = positionsBuffer.element(instanceIndex);

  // rotation
  const rotation = position.add(instanceIndex).mul(10);
  positionLocal.assign(rotate(positionLocal, rotation));
  normalLocal.assign(rotate(normalLocal, rotation));

  //scale
  const progressScale = min(
    progress.remap(0, 0.1),
    progress.remap(0.5, 1, 1, 0),
  ).clamp(0, 1);
  positionLocal.mulAssign(scale, scaleBuffer, progressScale);

  // position
  positionLocal.addAssign(position);

  return positionLocal;
})();

// color
material.colorNode = mix(
  colorA,
  colorB,
  colorMixBuffer.smoothstep(0, 1),
).toVertexStage();

const mesh = new THREE.Mesh(geometry, material);
mesh.count = count;
mesh.castShadow = true;
mesh.receiveShadow = true;
scene.add(mesh);

//Debug
const petalsGui = renderer.inspector.createParameters("Petals").close();
petalsGui.add(scale, "value", 0, 1, 0.001).name("scale");
petalsGui.addColor(colorA, "value").name("colorA");
petalsGui.addColor(colorB, "value").name("colorB");
petalsGui.add(radius, "value", 0, 1, 0.001).name("radius");
petalsGui.add(ambientRadius, "value", 0, 3, 0.01).name("ambientRadius");
petalsGui.add(windStrength, "value", 0, 0.01, 0.0001).name("windStrength");
petalsGui.add(windFrequency, "value", 0, 10, 0.01).name("windFrequency");
petalsGui.add(windVariation, "value", 0, 1, 0.01).name("windVariation");

/**
 * Title
 */
{
  const titleWidth = 2;
  const titleHeight = 1;
  const titleFitMargin = 0.9; // room for parallax + edges

  // Mesh
  const title = new THREE.Mesh(
    new THREE.PlaneGeometry(titleWidth, titleHeight),
    new THREE.MeshStandardNodeMaterial({
      transparent: true,
      alphaMap: textureLoader.load("./komarov.jpg"),
    }),
  );
  title.position.z = -0.05;
  title.receiveShadow = true;
  scene.add(title);

  updateTitleFit = () => {
    const distance = cameraBase.z - title.position.z;
    const visibleHeight =
      2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * distance;
    const visibleWidth = visibleHeight * camera.aspect;
    const fit = Math.min(
      (visibleWidth * titleFitMargin) / titleWidth,
      (visibleHeight * titleFitMargin) / titleHeight,
      1,
    );
    title.scale.setScalar(fit);
  };
  updateTitleFit();

  // Color
  const colorA = uniform(color(0xe00b9c));
  const colorB = uniform(color(0x0a0e8f));
  const centerDistance = uv().sub(vec2(0.5, 0.6)).length().mul(1.5).min(1);
  const colorMix = mix(colorA, colorB, centerDistance);
  title.material.colorNode = vec4(colorMix, 1);

  // Debug
  const titleGui = renderer.inspector.createParameters("Title").close();

  titleGui.addColor(colorA, "value").name("colorA");
  titleGui.addColor(colorB, "value").name("colorB");
}

/**
 * Lights
 */
const directionalLight = new THREE.DirectionalLight(0xffffff, 3);
directionalLight.castShadow = true;
directionalLight.position.set(1, 1, 0.75).normalize().multiplyScalar(5);
directionalLight.shadow.camera.far = 10;
directionalLight.shadow.mapSize.set(2048, 2048);
directionalLight.shadow.radius = 2;
directionalLight.shadow.normalBias = -0.1;
scene.add(directionalLight);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.05);
scene.add(ambientLight);

// Debug
const lightsGui = renderer.inspector.createParameters("Lights").close();

lightsGui.addColor(directionalLight, "color").name("directionalColor");
lightsGui
  .add(directionalLight, "intensity", 0, 5, 0.01)
  .name("directionalIntensity");

lightsGui.addColor(ambientLight, "color").name("ambientColor");
lightsGui.add(ambientLight, "intensity", 0, 5, 0.01).name("ambientIntensity");

/**
 * Animate
 */
const tick = () => {
  // Smooth parallax input — avoids jumps when cursor re-enters from another side
  const parallaxCursorX = pointerInside ? cursor.x : 0;
  const parallaxCursorY = pointerInside ? cursor.y : 0;
  cursorSmooth.x += (parallaxCursorX - cursorSmooth.x) * parallaxDamping;
  cursorSmooth.y += (parallaxCursorY - cursorSmooth.y) * parallaxDamping;

  parallaxTarget.set(
    cursorSmooth.x * parallaxStrength,
    cursorSmooth.y * parallaxStrength,
    cameraBase.z,
  );
  camera.position.x += (parallaxTarget.x - camera.position.x) * parallaxDamping;
  camera.position.y += (parallaxTarget.y - camera.position.y) * parallaxDamping;
  camera.position.z = cameraBase.z;

  lookAtTarget.set(
    -cursorSmooth.x * parallaxStrength * 0.35,
    -cursorSmooth.y * parallaxStrength * 0.35,
    0,
  );
  camera.lookAt(lookAtTarget);

  // cursor + raycaster
  raycaster.setFromCamera(cursor, camera);
  raycaster.ray.intersectPlane(intersetionPlane, intersect);
  // cursorHelper.position.copy(intersect);
  spawnPosition.value.copy(intersect);

  // Update petals
  renderer.compute(updatePetalsCompute);

  // Render
  renderPipeline.render();
};

renderer.setAnimationLoop(tick);
