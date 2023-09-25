import zgl, { type GL, type WrappedZGL, type ZGL } from '$lib/index.js';

const $ = (s: string) => document.querySelector(s);
const setDisplay = (el: string, val: string) => {
	if ($(el)) $(el)!.style.display = val;
};

type Demo = {};

export class DemoApp {
	singleMode: boolean;
	canvas: HTMLCanvasElement;
	z: ZGL;
	demo: Demo | null = null;
	gui: any = null;
	xrDemos: any;
	xrSession: any = null;
	xrRefSpace: any = null;
	xrPose: any = null;
	lookUpStartTime = 0;
	haveAR = false;
	haveVR = false;
	viewParams = {
		canvasSize: new Float32Array(2),
		pointer: new Float32Array(3),
		cameraYPD: new Float32Array(3),
		xrRay: new Float32Array(16 * 2),
		xrRayInv: new Float32Array(16 * 2),
		xrButton: new Float32Array(4 * 2)
	};
	withCamera: WrappedZGL;
	glsl_include = `
            uniform bool xrMode;
            uniform mat4 xrProjectionMatrix, xrViewMatrix;
            uniform mat4 xrRay[2], xrRayInv[2];
            uniform vec4 xrButton[2];
            uniform vec3 xrPosition;
            
            uniform vec3 cameraYPD;
            vec3 cameraPos() {
                if (xrMode) return xrPosition;
                vec3 p = vec3(0, 0, cameraYPD.z);
                p.yz *= rot2(-cameraYPD.y);
                p.xy *= rot2(-cameraYPD.x);
                return p;
            }
            vec4 wld2view(vec4 p) {
                if (xrMode) return xrViewMatrix * p;
                p.xy *= rot2(cameraYPD.x);
                p.yz *= rot2(cameraYPD.y);
                p.z -= cameraYPD.z;
                return p;
            }
            vec4 view2proj(vec4 p) {
                if (xrMode) return xrProjectionMatrix*p;
                const float near = 0.1, far = 10.0, fov = 1.0;
                return vec4(p.xy/tan(fov/2.0),
                    (p.z*(near+far)+2.0*near*far)/(near-far), -p.z);
            }
            vec4 wld2proj(vec4 p) {
                return view2proj(wld2view(p));
            }
            vec4 wld2proj(vec3 p) {
                return wld2proj(vec4(p,1.0));
            }
        `;

	constructor(
		public demos: Record<string, Demo>,
		defaultDemo = 'ParticleLife3d'
	) {
		const keys = Object.keys(demos);
		this.singleMode = keys.length == 1;
		if (this.singleMode) {
			defaultDemo = keys[0];
		}

		this.canvas = document.getElementById('c') as HTMLCanvasElement;
		const gl = this.canvas.getContext('webgl2', {
			alpha: false,
			antialias: true,
			xrCompatible: true
		}) as WebGL2RenderingContext;
		this.z = zgl(gl);
		this.demo = null;
		this.gui = null;

		this.xrDemos = Object.values(this.demos).filter((f) => f.Tags && f.Tags.includes('3d'));
		this.xrSession = null;
		this.xrRefSpace = null;
		this.xrPose = null;
		this.lookUpStartTime = 0;
		this.haveVR = this.haveAR = false;
		if (navigator.xr) {
			navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
				this.haveVR = supported;
				this.updateVRButtons();
			});
			navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
				this.haveAR = supported;
				this.updateVRButtons();
			});
		}

		this.resetCamera();

		this.withCamera = this.z.hook((z, params, target) => {
			params = { ...params, Inc: this.glsl_include + (params.Inc || '') };
			if (target || !params.xrMode) {
				return z(params, target);
			}
			delete params.Aspect;
			let glLayer = this.xrSession.renderState.baseLayer;
			target = {
				bind: (gl: GL) => {
					gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
					return [glLayer.framebufferWidth, glLayer.framebufferHeight];
				}
			};
			for (let view of this.xrPose.views) {
				const vp = glLayer.getViewport(view);
				params.View = [vp.x, vp.y, vp.width, vp.height];
				params.xrProjectionMatrix = view.projectionMatrix;
				params.xrViewMatrix = view.transform.inverse.matrix;
				let { x, y, z } = view.transform.position;
				params.xrPosition = [x, y, z];
				z(params, target);
			}
		});

		const setPointer = (e: PointerEvent, buttons: number) => {
			const [w, h] = this.viewParams.canvasSize;
			const [x, y] = [e.offsetX - w / 2, h / 2 - e.offsetY];
			this.viewParams.pointer.set([x, y, buttons]);
			return [x, y];
		};
		this.canvas.addEventListener('pointerdown', (e) => {
			if (!e.isPrimary) return;
			setPointer(e, e.buttons);
			if (window.innerWidth < 500) {
				// close menu on small screens
				$('#panel').removeAttribute('open');
			}
		});
		this.canvas.addEventListener('pointerout', (e) => setPointer(e, 0));
		this.canvas.addEventListener('pointerup', (e) => setPointer(e, 0));
		this.canvas.addEventListener('pointermove', (e) => {
			const [px, py, _] = this.viewParams.pointer;
			const [x, y] = setPointer(e, e.buttons);
			if (!e.isPrimary || e.buttons != 1) return;
			let [yaw, pitch, dist] = this.viewParams.cameraYPD;
			yaw -= (x - px) * 0.01;
			pitch += (y - py) * 0.01;
			pitch = Math.min(Math.max(pitch, 0), Math.PI);
			this.viewParams.cameraYPD.set([yaw, pitch, dist]);
		});

		let name = location.hash.slice(1);
		if (!(name in this.demos)) {
			name = defaultDemo;
		}
		this.runDemo(name);
		this.populatePreviews();

		requestAnimationFrame(this.frame.bind(this));
	}

	resetCamera() {
		this.viewParams.cameraYPD.set([(Math.PI * 3) / 4, Math.PI / 4, 1.8]);
	}

	frame(t: number) {
		requestAnimationFrame(this.frame.bind(this));
		if (this.xrSession) return; // skip canvas frames when XR is running
		this.z.adjustCanvas(1); // fix devicePixelRatio to 1
		this.viewParams.canvasSize.set([this.canvas.clientWidth, this.canvas.clientHeight]);

		this.demo!.frame(this.withCamera, {
			time: t / 1000.0,
			xrMode: false,
			...this.viewParams
		});
	}

	xrFrame(t: number, xrFrame) {
		this.xrSession.requestAnimationFrame(this.xrFrame.bind(this));
		this.xrPose = xrFrame.getViewerPose(this.xrRefSpace);
		if (!this.xrPose) return;
		this.viewParams.xrRay.fill(0.0);
		this.viewParams.xrRayInv.fill(0.0);
		this.viewParams.xrButton.fill(0.0);
		const params = { time: t / 1000.0, xrMode: true, ...this.viewParams };
		for (let i = 0; i < 2; ++i) {
			const inputSource = this.xrSession.inputSources[i];
			if (inputSource && inputSource.gamepad && inputSource.gamepad.buttons) {
				inputSource.gamepad.buttons.forEach((btn, btnIdx) => {
					if (btnIdx < 4) this.viewParams.xrButton[i * 4 + btnIdx] = btn.value || btn.pressed;
				});
			}
			if (!inputSource || !inputSource.targetRaySpace) continue;
			const pose = xrFrame.getPose(inputSource.targetRaySpace, this.xrRefSpace);
			if (!pose) continue;
			this.viewParams.xrRay.set(pose.transform.matrix, i * 16);
			this.viewParams.xrRayInv.set(pose.transform.inverse.matrix, i * 16);
		}

		this.demo!.frame(this.withCamera, params);
		this.withCamera({
			...params,
			Mesh: [20, 20],
			Grid: [2],
			DepthTest: 1,
			VP: `
            varying vec3 p = uv2sphere(UV);
            varying vec4 buttons = xrButton[ID.x];
            VPos = wld2proj(xrRay[ID.x]*vec4(p*vec3(0.02, 0.02, 0.1),1));`,
			FP: `
            vec3 c = p*0.5+0.5;
            FOut = vec4(c*0.5,1);
            float b = c.z*4.0;
            if (b<4.0 && buttons[int(b)]>fract(b)) FOut += 0.5;`
		});

		const lookUpCoef = -this.xrPose.transform.matrix[10];
		if (!this.singleMode && lookUpCoef > 0.5) {
			const dt = (t - this.lookUpStartTime) / 1000;
			if (dt > 1) {
				this.lookUpStartTime = t;
				let i = this.xrDemos.indexOf(this.demo!.constructor);
				i = (i + 1) % this.xrDemos.length;
				this.runDemo(this.xrDemos[i].name);
			} else {
				this.withCamera({
					...params,
					Mesh: [20, 20],
					dt,
					DepthTest: 1,
					VP: `
                vec3 p = uv2sphere(UV)*0.6*clamp(1.0-dt, 0.0, 0.8) + vec3(-2.0, 0.0, 3.0);
                VPos = wld2proj(vec4(p,1));`,
					FP: `UV,0.5,1`
				});
			}
		} else {
			this.lookUpStartTime = t;
		}
	}

	toggleXR(xr) {
		if (!this.xrSession) {
			navigator.xr.requestSession(`immersive-${xr}`).then((session) => {
				this.xrSession = session;
				session.addEventListener('end', () => {
					this.xrSession = null;
				});
				session.updateRenderState({ baseLayer: new XRWebGLLayer(session, this.z.gl) });
				session.requestReferenceSpace('local').then((refSpace) => {
					this.xrRefSpace = refSpace.getOffsetReferenceSpace(
						new XRRigidTransform(
							{ x: 0, y: -0.25, z: -1.0, w: 1 }, // position offset
							{ x: 0.5, y: 0.5, z: 0.5, w: -0.5 }
						) // rotate z up
					);
					session.requestAnimationFrame(this.xrFrame.bind(this));
				});
			});
		} else {
			this.xrSession.end();
		}
	}

	runDemo(name: string) {
		if (this.demo) {
			if (this.gui) this.gui.destroy();
			if (this.demo.free) this.demo.free();
			this.z.reset();
			this.demo = this.gui = null;
		}
		if (!this.singleMode) location.hash = name;
		if (self.dat) {
			this.gui = new dat.GUI();
			this.gui.domElement.id = 'gui';
			this.gui.hide();
		}
		this.demo = new this.demos[name](this.withCamera, this.gui);
		if (this.gui && this.gui.__controllers.length == 0) {
			this.gui.destroy();
			this.gui = null;
		}
		setDisplay('#settingButton', this.gui ? 'block' : 'none');
		if ($('#sourceLink')) {
			$('#sourceLink').href = `https://github.com/pluvial/zgl/blob/main/src/routes/demo/${name}.js`;
		}
		this.updateVRButtons();
		this.resetCamera();
	}

	updateVRButtons() {
		setDisplay('#vrButton', 'none');
		setDisplay('#arButton', 'none');
		const tags = this.demo && this.demo.constructor.Tags;
		if (tags && tags.includes('3d')) {
			if (this.haveVR) setDisplay('#vrButton', 'block');
			if (this.haveAR) setDisplay('#arButton', 'block');
		}
	}

	populatePreviews() {
		const panel = document.getElementById('cards');
		if (!panel) return;
		Object.keys(this.demos).forEach((name) => {
			const el = document.createElement('div');
			el.classList.add('card');
			el.innerHTML = `<img src="/preview/${name}.jpg">${name}`;
			el.addEventListener('click', () => this.runDemo(name));
			panel.appendChild(el);
		});
	}

	// helper function to render demo preview images
	genPreviews() {
		const panel = document.getElementById('cards') as HTMLDetailsElement;
		panel.innerHTML = '';
		const canvas = document.createElement('canvas');
		canvas.width = 400;
		canvas.height = 300;
		const z = zgl(canvas);
		const withCamera = z.hook((z, p, t) => z({ ...p, Inc: this.glsl_include + (p.Inc || '') }, t));
		Object.keys(this.demos).forEach((name) => {
			if (name == 'Spectrogram') return;
			const dummyGui = new dat.GUI();
			const demo = new this.demos[name](withCamera, dummyGui);
			dummyGui.destroy();
			this.resetCamera();
			for (let i = 0; i < 60 * 5; ++i) {
				withCamera({ Clear: 0 }, '');
				demo.frame(withCamera, { time: i / 60.0, ...this.viewParams });
			}
			const el = document.createElement('div');
			const data = canvas.toDataURL('image/jpeg', 0.95);
			el.innerHTML = `
             <a href="${data}" download="${name}.jpg"><img src="${data}"></a>
             ${name}`;
			panel.appendChild(el);
			if (demo.free) demo.free();
			z.reset();
		});
	}

	toggleGui() {
		if (!this.gui) return;
		const style = this.gui.domElement.style;
		style.display = style.display == 'none' ? '' : 'none';
	}

	fullscreen() {
		const { canvas } = this;
		const f = canvas.requestFullscreen || canvas.webkitRequestFullscreen;
		if (f) f.apply(canvas);
	}
}
