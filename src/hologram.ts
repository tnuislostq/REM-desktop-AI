import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';

export type Mode = 'idle' | 'listening' | 'thinking' | 'speaking';
export interface Frame { mode: Mode; level: number }

const COLORS: Record<Mode, number> = {
  idle: 0x4cc9f0,
  listening: 0x9bf6ff,
  thinking: 0xffb347,
  speaking: 0x5ad8ff,
};

/**
 * The arc-reactor core is the default "face" of Rem. If public/models/avatar.vrm exists,
 * that character stands in front of it instead (lip-synced and blinking).
 */
export class Hologram {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private reactor = new THREE.Group();
  private rings: THREE.Mesh[] = [];
  private blades: THREE.Mesh[] = [];
  private core: THREE.Mesh;
  private dust: THREE.Points;
  private mats: THREE.MeshBasicMaterial[] = [];
  private vrm: VRM | null = null;
  private clock = new THREE.Clock();
  private raf = 0;
  private color = new THREE.Color(COLORS.idle);
  private smooth = 0;
  private blink = 0;
  private nextBlink = 2;
  private pointer = new THREE.Vector2();

  constructor(private el: HTMLElement, private frame: () => Frame) {
    const w = el.clientWidth || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    el.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
    this.camera.position.set(0, 0, 7);

    const mat = (opacity = 1) => {
      const m = new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
      this.mats.push(m);
      return m;
    };

    // Core
    this.core = new THREE.Mesh(new THREE.SphereGeometry(0.55, 48, 48), mat(0.95));
    this.reactor.add(this.core);

    // Iconic ring of reactor blades
    const bladeGeo = new THREE.BoxGeometry(0.34, 0.16, 0.06);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const b = new THREE.Mesh(bladeGeo, mat(0.85));
      b.position.set(Math.cos(a) * 1.15, Math.sin(a) * 1.15, 0);
      b.rotation.z = a;
      this.reactor.add(b);
      this.blades.push(b);
    }

    // Orbiting rings
    const ringSpecs: [number, number, number, number][] = [
      [1.6, 0.012, 0.6, 0], [2.0, 0.01, 0.4, 1.1], [2.5, 0.008, 0.3, -0.9], [3.1, 0.006, 0.2, 0.4],
    ];
    for (const [r, t, o, tilt] of ringSpecs) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, t, 8, 160), mat(o));
      ring.rotation.x = tilt;
      this.reactor.add(ring);
      this.rings.push(ring);
    }

    // Dust shell
    const N = 700;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 2.2 + Math.random() * 2.2;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th) * 0.6, r * Math.cos(ph)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(g, new THREE.PointsMaterial({ color: this.color, size: 0.02, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.reactor.add(this.dust);
    this.scene.add(this.reactor);

    // Post-processing glow
    this.composer = new EffectComposer(this.renderer);
    this.composer.setSize(w, h);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.9, 0.7, 0.05);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    window.addEventListener('resize', this.onResize);
    window.addEventListener('pointermove', this.onPointer);
    this.loop();
    void this.tryLoadAvatar('/models/avatar.vrm');
  }

  private onResize = () => {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  };

  private onPointer = (e: PointerEvent) => {
    this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1));
  };

  private async tryLoadAvatar(url: string) {
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (!head.ok || (head.headers.get('content-type') || '').includes('text/html')) return; // dev server fallback page
      const loader = new GLTFLoader();
      loader.register(p => new VRMLoaderPlugin(p));
      const gltf = await loader.loadAsync(url);
      const vrm = gltf.userData.vrm as VRM;
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.rotateVRM0(vrm);
      // Relax the T-pose: arms down. If they point the wrong way on your model, flip the signs.
      const arm = (n: 'leftUpperArm' | 'rightUpperArm', z: number) => { const b = vrm.humanoid.getNormalizedBoneNode(n); if (b) b.rotation.z = z; };
      arm('leftUpperArm', -1.2);
      arm('rightUpperArm', 1.2);
      vrm.scene.position.set(0, -1.75, 2.4);
      vrm.scene.scale.setScalar(1.35);
      this.scene.add(vrm.scene);
      this.vrm = vrm;
      this.reactor.scale.setScalar(1.25);
      this.reactor.position.set(0, 0.1, -1.5);
      this.core.visible = false;
      this.blades.forEach(b => (b.visible = false));
      this.scene.add(new THREE.AmbientLight(0xffffff, 1.2));
      const key = new THREE.DirectionalLight(0xffffff, 2);
      key.position.set(1, 2, 3);
      this.scene.add(key);
    } catch (e) {
      console.warn('Avatar not loaded, using the arc reactor.', e);
    }
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;
    const { mode, level } = this.frame();

    this.smooth += (level - this.smooth) * Math.min(1, dt * 12);
    const lvl = this.smooth;

    // Colour eases between modes
    this.color.lerp(new THREE.Color(COLORS[mode]), Math.min(1, dt * 5));
    this.mats.forEach(m => m.color.copy(this.color));
    (this.dust.material as THREE.PointsMaterial).color.copy(this.color);

    const spin = mode === 'thinking' ? 2.6 : mode === 'speaking' ? 0.9 : mode === 'listening' ? 0.6 : 0.25;
    this.rings.forEach((r, i) => {
      r.rotation.z += dt * spin * (i % 2 ? -1 : 1) * (0.6 + i * 0.25);
      r.rotation.y += dt * 0.12 * (i + 1);
    });
    this.blades.forEach((b, i) => { b.scale.x = 1 + lvl * 0.9 * Math.sin(t * 6 + i); });
    this.core.scale.setScalar(1 + lvl * 0.35 + Math.sin(t * 2) * 0.03);
    this.dust.rotation.y += dt * (0.05 + lvl * 0.4);

    this.bloom.strength = 0.7 + lvl * 0.9 + (mode === 'thinking' ? 0.3 : 0);

    // Gentle parallax toward the pointer
    this.reactor.rotation.y += (this.pointer.x * 0.25 - this.reactor.rotation.y) * dt * 2;
    this.reactor.rotation.x += (-this.pointer.y * 0.15 - this.reactor.rotation.x) * dt * 2;

    if (this.vrm) {
      const em = this.vrm.expressionManager;
      if (em) {
        em.setValue('aa', mode === 'speaking' ? Math.min(1, lvl * 1.2) : 0);
        this.nextBlink -= dt;
        if (this.nextBlink <= 0) { this.blink = 1; this.nextBlink = 2 + Math.random() * 3; }
        this.blink = Math.max(0, this.blink - dt * 8);
        em.setValue('blink', this.blink);
      }
      this.vrm.scene.rotation.y = Math.sin(t * 0.5) * 0.06 + this.pointer.x * 0.2;
      this.vrm.update(dt);
    }

    this.composer.render();
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pointermove', this.onPointer);
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
