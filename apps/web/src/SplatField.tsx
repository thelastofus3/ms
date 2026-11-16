import { useEffect, useRef } from "react";
import * as THREE from "three";

export type SplatShape = "room" | "capture" | "figure" | "scene";
type Cloud = { positions: Float32Array; colors: Float32Array };
type V3 = [number, number, number];

// Depth-map spectrum: cyan → violet → magenta → amber.
const stops: V3[] = [[0.2, 0.9, 1], [0.48, 0.38, 1], [1, 0.31, 0.76], [1, 0.69, 0.29]];
const spectrum = (t: number): V3 => {
  const x = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1), i = Math.floor(x), f = x - i, a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
};
const gauss = () => { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); };

/** Weighted point samplers; `build` draws exactly `count` points from them. */
type Sampler = { weight: number; sample: () => { p: V3; c: V3 } };
function build(count: number, samplers: Sampler[]): Cloud {
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3);
  const total = samplers.reduce((sum, s) => sum + s.weight, 0);
  let index = 0;
  samplers.forEach((s, n) => {
    const end = n === samplers.length - 1 ? count : Math.min(count, index + Math.round(count * s.weight / total));
    for (; index < end; index++) { const { p, c } = s.sample(); positions.set(p, index * 3); colors.set(c, index * 3); }
  });
  return { positions, colors };
}
const tint = (c: V3, k: number): V3 => [c[0] * k, c[1] * k, c[2] * k];
const rect = (o: V3, u: V3, v: V3, color: (a: number, b: number, p: V3) => V3, weight: number): Sampler => ({ weight, sample: () => {
  const a = Math.random(), b = Math.random(), p: V3 = [o[0] + u[0] * a + v[0] * b, o[1] + u[1] * a + v[1] * b, o[2] + u[2] * a + v[2] * b];
  return { p, c: color(a, b, p) };
} });
const box = (center: V3, size: V3, color: V3, weight: number): Sampler => ({ weight, sample: () => {
  const areas = [size[1] * size[2], size[0] * size[2], size[0] * size[1]];
  let pick = Math.random() * (areas[0] + areas[1] + areas[2]), axis = 0;
  while (axis < 2 && pick > areas[axis]) pick -= areas[axis++];
  const p: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) p[i] = center[i] + (i === axis ? (Math.random() < 0.5 ? -0.5 : 0.5) : Math.random() - 0.5) * size[i];
  return { p, c: tint(color, 0.55 + 0.45 * (p[1] - center[1] + size[1] / 2) / size[1]) };
} });
const segment = (a: V3, b: V3, radius: number, color: (t: number, p: V3) => V3, weight: number): Sampler => {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), n1 = new THREE.Vector3(1, 0.3, 0.2).cross(d).normalize(), n2 = d.clone().cross(n1).normalize();
  return { weight, sample: () => {
    const t = Math.random(), angle = Math.random() * Math.PI * 2, r = radius * (0.85 + 0.15 * Math.random());
    const p: V3 = [a[0] + d.x * t + (n1.x * Math.cos(angle) + n2.x * Math.sin(angle)) * r, a[1] + d.y * t + (n1.y * Math.cos(angle) + n2.y * Math.sin(angle)) * r, a[2] + d.z * t + (n1.z * Math.cos(angle) + n2.z * Math.sin(angle)) * r];
    return { p, c: color(t, p) };
  } };
};
const ellipsoid = (center: V3, radii: V3, color: (p: V3) => V3, weight: number): Sampler => ({ weight, sample: () => {
  const v = new THREE.Vector3(gauss(), gauss(), gauss()).normalize(), p: V3 = [center[0] + v.x * radii[0], center[1] + v.y * radii[1], center[2] + v.z * radii[2]];
  return { p, c: color(p) };
} });
/** A capture camera drawn as a small frustum looking at `target`. */
const frustum = (eye: V3, target: V3, color: V3, weight: number): Sampler => {
  const forward = new THREE.Vector3(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]).normalize(), right = new THREE.Vector3(0, 1, 0).cross(forward).normalize(), up = forward.clone().cross(right);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => new THREE.Vector3(...eye).addScaledVector(forward, 0.2).addScaledVector(right, x * 0.11).addScaledVector(up, y * 0.075));
  const apex = new THREE.Vector3(...eye), edges: [THREE.Vector3, THREE.Vector3][] = corners.flatMap((corner, i) => [[apex, corner], [corner, corners[(i + 1) % 4]]]);
  return { weight, sample: () => { const [a, b] = edges[Math.floor(Math.random() * edges.length)], p = a.clone().lerp(b, Math.random()); return { p: [p.x, p.y, p.z], c: color }; } };
};

function room(count: number): Cloud {
  const byHeight = (p: V3) => spectrum(0.08 + p[1] / 2.5 * 0.5), amber = spectrum(0.98), cyan = spectrum(0.02);
  const grid = (a: number, b: number, p: V3): V3 => tint(spectrum(0.02 + (p[2] + 1.6) / 3.2 * 0.3), Math.min(a * 10 % 1, b * 8 % 1) < 0.06 ? 1.6 : 0.7);
  const cameras = Array.from({ length: 9 }, (_, i): Sampler => { const angle = -0.5 + i * 0.5, eye: V3 = [Math.sin(angle) * 2.1 + 0.3, 1.25 + Math.sin(i * 1.7) * 0.25, Math.cos(angle) * 1.7 + 0.5]; return frustum(eye, [0, 0.8, -0.2], amber, 0.13); });
  return build(count, [
    rect([-2, 0, -1.6], [4, 0, 0], [0, 0, 3.2], grid, 9),
    rect([-2, 0, -1.6], [4, 0, 0], [0, 2.5, 0], (_a, _b, p) => tint(byHeight(p), 0.95), 7),
    rect([-2, 0, -1.6], [0, 0, 3.2], [0, 2.5, 0], (_a, _b, p) => tint(byHeight(p), 0.8), 5.5),
    // Window: bright frame and mullions on the back wall.
    rect([0.35, 1.0, -1.58], [1.2, 0, 0], [0, 1.05, 0], (a, b) => tint(cyan, Math.min(a, 1 - a, b, 1 - b, Math.abs(a - 0.5), Math.abs(b - 0.5)) < 0.035 ? 1.6 : 0.5), 2.2),
    box([-1.05, 0.33, -1.0], [1.7, 0.42, 0.75], spectrum(0.62), 3), box([-1.05, 0.72, -1.3], [1.7, 0.5, 0.16], spectrum(0.7), 1.6),
    box([-1.82, 0.6, -1.0], [0.16, 0.34, 0.75], spectrum(0.66), 0.5), box([-0.28, 0.6, -1.0], [0.16, 0.34, 0.75], spectrum(0.66), 0.5),
    box([0.75, 0.42, 0.25], [1.15, 0.06, 0.65], spectrum(0.86), 1.4),
    ...[[0.25, 0], [1.25, 0], [0.25, 0.5], [1.25, 0.5]].map(([x, z]) => segment([x, 0, z], [x, 0.4, z], 0.025, () => spectrum(0.86), 0.2)),
    segment([1.7, 0, -1.25], [1.7, 1.45, -1.25], 0.02, () => spectrum(0.9), 0.3), ellipsoid([1.7, 1.6, -1.25], [0.2, 0.17, 0.2], () => tint(amber, 1.5), 0.9),
    rect([-0.9, 0.012, -0.25], [2.3, 0, 0], [0, 0, 1.35], (a, b) => tint(spectrum(0.52), Math.min(a, 1 - a, b, 1 - b) < 0.06 ? 1.3 : 0.5), 1.6),
    box([-1.6, 1.55, -1.57], [0.5, 0.65, 0.03], spectrum(0.4), 0.5),
    ...cameras,
  ]);
}
function figure(count: number, captured: boolean): Cloud {
  const skin = (_t: number, p: V3) => spectrum(0.04 + p[1] / 1.8 * 0.9), body = (p: V3) => spectrum(0.04 + p[1] / 1.8 * 0.9);
  const limbs: Sampler[] = [-1, 1].flatMap(side => {
    const raised = !captured && side > 0;
    const shoulder: V3 = [side * 0.21, 1.44, 0], elbow: V3 = raised ? [0.42, 1.62, 0.02] : [side * 0.33, 1.17, 0], hand: V3 = raised ? [0.5, 1.93, 0.05] : [side * 0.43, 0.9, 0.04];
    return [segment(shoulder, elbow, 0.05, skin, 1), segment(elbow, hand, 0.04, skin, 0.9), ellipsoid(hand, [0.045, 0.06, 0.03], body, 0.25),
      segment([side * 0.1, 0.95, 0], [side * 0.12, 0.5, 0.01], 0.075, skin, 1.6), segment([side * 0.12, 0.5, 0.01], [side * 0.13, 0.08, 0], 0.055, skin, 1.3), ellipsoid([side * 0.13, 0.04, 0.06], [0.055, 0.04, 0.12], body, 0.4)];
  });
  const rig: Sampler[] = captured
    ? Array.from({ length: 24 }, (_, i) => { const angle = i / 24 * Math.PI * 2, eye: V3 = [Math.sin(angle) * 1.35, 0.55 + (i % 3) * 0.5, Math.cos(angle) * 1.35]; return frustum(eye, [0, 1, 0], spectrum(0.98), 0.3); })
    : [0.45, 0.75, 1.05].map((radius, i): Sampler => ({ weight: 1.1, sample: () => { const angle = Math.random() * Math.PI * 2; return { p: [Math.sin(angle) * radius, 0.01, Math.cos(angle) * radius], c: tint(spectrum(0.1 + i * 0.2), 0.9) }; } }));
  return build(count, [
    ellipsoid([0, 1.66, 0], [0.105, 0.13, 0.115], body, 1.5), segment([0, 1.5, 0], [0, 1.56, 0], 0.045, skin, 0.2),
    ellipsoid([0, 1.25, 0], [0.2, 0.27, 0.115], body, 3.6), ellipsoid([0, 0.97, 0], [0.17, 0.14, 0.11], body, 1.6),
    ...limbs, ...rig,
    { weight: 2.2, sample: () => { const radius = Math.sqrt(Math.random()) * 1.5, angle = Math.random() * Math.PI * 2; return { p: [Math.sin(angle) * radius, 0, Math.cos(angle) * radius], c: tint(spectrum(0.3), 0.4 * (1 - radius / 1.6)) }; } },
  ]);
}
/** Raw anisotropic Gaussians, the way an imported PLY looks before it reads as a place. */
function scene(count: number): Cloud {
  const blobs: Sampler[] = Array.from({ length: 16 }, (_, i) => {
    const angle = i * 2.4, radius = 0.25 + Math.sqrt(i) * 0.33, center = new THREE.Vector3(Math.cos(angle) * radius, (i % 5) * 0.16 - 0.3, Math.sin(angle) * radius);
    const basis = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(i * 1.3, i * 2.1, i * 0.7)), scale = new THREE.Vector3(0.08 + (i * 7 % 5) * 0.07, 0.03 + (i * 3 % 4) * 0.03, 0.06 + (i * 5 % 6) * 0.05), color = spectrum(i * 0.61 % 1);
    return { weight: scale.x * scale.z * 40 + 0.4, sample: () => { const v = new THREE.Vector3(gauss() * scale.x, gauss() * scale.y, gauss() * scale.z).applyMatrix4(basis).add(center); return { p: [v.x, v.y + 1, v.z] as V3, c: tint(color, 0.5 + Math.random() * 0.6) }; } };
  });
  return build(count, blobs);
}
const clouds: Record<SplatShape, (count: number) => Cloud> = { room, capture: n => figure(n, true), figure: n => figure(n, false), scene };
// Where the orbit looks, and how far back it stands, per shape.
const framing: Record<SplatShape, { y: number; distance: number }> = { room: { y: 1.05, distance: 5.5 }, capture: { y: 0.95, distance: 4.3 }, figure: { y: 0.95, distance: 3.9 }, scene: { y: 0.95, distance: 4.0 } };

const vertexShader = `
attribute vec3 aFrom; attribute vec3 aTo; attribute vec3 aColorFrom; attribute vec3 aColorTo; attribute float aSeed;
uniform float uProgress, uTime, uSize;
varying vec3 vColor;
void main() {
  float p = clamp(uProgress * 1.7 - aSeed * 0.7, 0.0, 1.0); p = p * p * (3.0 - 2.0 * p);
  vec3 pos = mix(aFrom, aTo, p);
  pos += sin(p * 3.14159) * 0.45 * vec3(sin(aSeed * 40.0 + uTime), cos(aSeed * 31.0 + uTime * 0.7), sin(aSeed * 17.0 - uTime));
  pos += 0.006 * vec3(sin(uTime * 1.3 + aSeed * 90.0), cos(uTime * 1.1 + aSeed * 70.0), sin(uTime * 0.9 + aSeed * 50.0));
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (0.55 + aSeed * 0.9) / -mv.z;
  vColor = mix(aColorFrom, aColorTo, p) * (0.8 + 0.2 * sin(uTime * 2.0 + aSeed * 60.0));
}`;
const fragmentShader = `
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5), a = exp(-d * d * 22.0);
  if (a < 0.03) discard;
  gl_FragColor = vec4(vColor * a, a);
}`;

/** Decorative point cloud that assembles from noise and morphs between shapes. Renders nothing when WebGL is unavailable. */
export default function SplatField({ shape, className }: { shape: SplatShape; className?: string }) {
  const host = useRef<HTMLDivElement>(null), morph = useRef<(next: SplatShape) => void>(undefined);
  useEffect(() => {
    const element = host.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "low-power" }); } catch { return; }
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const count = innerWidth < 760 ? 22000 : 60000;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75)); renderer.setClearColor(0, 0);
    renderer.domElement.setAttribute("aria-hidden", "true");
    element.append(renderer.domElement);
    const cache: Partial<Record<SplatShape, Cloud>> = {}, cloud = (name: SplatShape) => cache[name] ??= clouds[name](count);
    let current = shape, target = cloud(current);
    const from = new Float32Array(count * 3), colorFrom = new Float32Array(count * 3), seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) { seeds[i] = Math.random(); from.set([gauss() * 2.6, 1 + gauss() * 1.6, gauss() * 2.6], i * 3); colorFrom.set(tint(spectrum(Math.random()), 0.5), i * 3); }
    const geometry = new THREE.BufferGeometry();
    const attributes = { position: new THREE.BufferAttribute(target.positions.slice(), 3), aFrom: new THREE.BufferAttribute(from, 3), aTo: new THREE.BufferAttribute(target.positions.slice(), 3), aColorFrom: new THREE.BufferAttribute(colorFrom, 3), aColorTo: new THREE.BufferAttribute(target.colors.slice(), 3), aSeed: new THREE.BufferAttribute(seeds, 1) };
    Object.entries(attributes).forEach(([name, attribute]) => geometry.setAttribute(name, attribute));
    const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, uniforms: { uProgress: { value: still ? 1 : 0 }, uTime: { value: 0 }, uSize: { value: 30 } } });
    const points = new THREE.Points(geometry, material); points.frustumCulled = false;
    const scene3 = new THREE.Scene(), camera = new THREE.PerspectiveCamera(34, 1, 0.1, 50);
    scene3.add(points);
    let progress = still ? 1 : 0, duration = 2.6, frame = 0, last = performance.now(), time = 0, visible = true, disposed = false;
    let lookY = framing[current].y, distance = framing[current].distance;
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    morph.current = next => {
      if (next === current) return;
      // Bake the in-flight positions so a new morph starts from where each point is now.
      const to = attributes.aTo.array as Float32Array, colorTo = attributes.aColorTo.array as Float32Array;
      for (let i = 0; i < count; i++) {
        let p = Math.min(1, Math.max(0, progress * 1.7 - seeds[i] * 0.7)); p = p * p * (3 - 2 * p);
        for (let k = i * 3; k < i * 3 + 3; k++) { from[k] += (to[k] - from[k]) * p; colorFrom[k] += (colorTo[k] - colorFrom[k]) * p; }
      }
      current = next; target = cloud(next);
      to.set(target.positions); colorTo.set(target.colors);
      [attributes.aFrom, attributes.aTo, attributes.aColorFrom, attributes.aColorTo].forEach(attribute => { attribute.needsUpdate = true; });
      progress = still ? 1 : 0; duration = 1.5; material.uniforms.uProgress.value = progress;
      if (still) draw(0);
    };
    const draw = (delta: number) => {
      if (!still) { time += delta; progress = Math.min(1, progress + delta / duration); }
      pointer.x += (pointer.tx - pointer.x) * Math.min(1, delta * 3); pointer.y += (pointer.ty - pointer.y) * Math.min(1, delta * 3);
      const ease = Math.min(1, delta * 2.5 || 1), goal = framing[current];
      lookY += (goal.y - lookY) * ease; distance += (goal.distance - distance) * ease;
      // Narrow hosts stand further back so the shape still fits.
      const reach = distance * Math.max(1, 1.25 / camera.aspect), angle = 0.62 + Math.sin(time * 0.16) * 0.42 + pointer.x * 0.35;
      camera.position.set(Math.sin(angle) * reach, lookY + 0.9 - pointer.y * 0.5, Math.cos(angle) * reach); camera.lookAt(0, lookY, 0);
      material.uniforms.uProgress.value = progress; material.uniforms.uTime.value = time;
      renderer.render(scene3, camera);
    };
    const loop = (now: number) => {
      frame = 0;
      if (disposed || !visible || document.hidden) return;
      draw(Math.min(0.05, (now - last) / 1000)); last = now;
      if (!still) frame = requestAnimationFrame(loop);
    };
    const wake = () => { if (!frame && !disposed) { last = performance.now(); frame = requestAnimationFrame(loop); } };
    const resize = () => {
      const width = element.clientWidth, height = element.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix();
      material.uniforms.uSize.value = height * renderer.getPixelRatio() * 0.05;
      if (still) draw(0); else wake();
    };
    const observer = new ResizeObserver(resize); observer.observe(element);
    const watcher = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); if (visible) wake(); }); watcher.observe(element);
    const move = (event: PointerEvent) => { pointer.tx = event.clientX / innerWidth * 2 - 1; pointer.ty = event.clientY / innerHeight * 2 - 1; };
    if (!still) addEventListener("pointermove", move, { passive: true });
    document.addEventListener("visibilitychange", wake);
    resize();
    return () => {
      disposed = true; morph.current = undefined; cancelAnimationFrame(frame); observer.disconnect(); watcher.disconnect();
      removeEventListener("pointermove", move); document.removeEventListener("visibilitychange", wake);
      geometry.dispose(); material.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
  }, []);
  useEffect(() => { morph.current?.(shape); }, [shape]);
  return <div ref={host} className={className} aria-hidden="true" />;
}
