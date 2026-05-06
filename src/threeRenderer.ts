import * as THREE from "three";

export type RendererAPI = {
    domElement: HTMLCanvasElement;
    addLine: (points: THREE.Vector3[], color: number) => void;
    addPoint: (position: THREE.Vector3, color: THREE.Color) => void;
    removeLastPointObject: () => void;
    removeFirstPointObject: () => void;
    clearSceneObjects: () => void;
    screenToWorld: (clientX: number, clientY: number) => THREE.Vector3;
    dispose: () => void;
    camera: THREE.OrthographicCamera;
    setSize: (w: number, h: number) => void;
};

export function createThreeRenderer(container: HTMLDivElement): RendererAPI {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7f8fa);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);

    const lineObjects: THREE.Line[] = [];
    const pointObjects: THREE.Mesh[] = [];

    const addLine = (points: THREE.Vector3[], color: number) => {
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({ color });
        const line = new THREE.Line(geometry, material);
        scene.add(line);
        lineObjects.push(line);
    };

    const removeLastLine = () => {
        const l = lineObjects.pop();
        if (!l) return;
        l.geometry.dispose();
        (l.material as THREE.Material).dispose();
        scene.remove(l);
    };

    const getLineCount = () => lineObjects.length;

    const addPoint = (position: THREE.Vector3, color: THREE.Color) => {
        const geometry = new THREE.SphereGeometry(3, 24, 24);
        const material = new THREE.MeshBasicMaterial({ color });
        const sphere = new THREE.Mesh(geometry, material);
        sphere.position.copy(position);
        scene.add(sphere);
        pointObjects.push(sphere);
    };

    const removeLastPointObject = () => {
        const p = pointObjects.pop();
        if (!p) return;
        (p.geometry as THREE.BufferGeometry).dispose();
        (p.material as THREE.Material).dispose();
        scene.remove(p);
    };

    const removeAllPointObjects = () => {
        while (pointObjects.length) {
            const p = pointObjects.pop()!;
            (p.geometry as THREE.BufferGeometry).dispose();
            (p.material as THREE.Material).dispose();
            scene.remove(p);
        }
    };

    const removeFirstPointObject = () => {
        const p = pointObjects.shift();
        if (!p) return;
        (p.geometry as THREE.BufferGeometry).dispose();
        (p.material as THREE.Material).dispose();
        scene.remove(p);
    };

    const clearSceneObjects = () => {
        while (lineObjects.length) {
            const l = lineObjects.pop()!;
            l.geometry.dispose();
            (l.material as THREE.Material).dispose();
            scene.remove(l);
        }
        while (pointObjects.length) {
            const p = pointObjects.pop()!;
            (p.geometry as THREE.BufferGeometry).dispose();
            (p.material as THREE.Material).dispose();
            scene.remove(p);
        }
    };

    const screenToWorld = (clientX: number, clientY: number) => {
        const rect = container.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;

        const normalizedX = (x / rect.width) * 2 - 1;
        const normalizedY = -(y / rect.height) * 2 + 1;

        const vector = new THREE.Vector3(normalizedX, normalizedY, 0);
        vector.unproject(camera);

        return vector;
    };

    const resize = () => {
        const width = Math.max(container.clientWidth, 1);
        const height = Math.max(container.clientHeight, 1);
        renderer.setSize(width, height);
        camera.left = -width / 2;
        camera.right = width / 2;
        camera.top = height / 2;
        camera.bottom = -height / 2;
        camera.updateProjectionMatrix();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    let animationFrameId = 0;
    const render = () => {
        animationFrameId = window.requestAnimationFrame(render);
        renderer.render(scene, camera);
    };
    render();

    const dispose = () => {
        window.cancelAnimationFrame(animationFrameId);
        resizeObserver.disconnect();
        clearSceneObjects();
        renderer.dispose();
        if (renderer.domElement.parentElement === container) {
            container.removeChild(renderer.domElement);
        }
    };

    return {
        domElement: renderer.domElement,
        addLine,
        addPoint,
        removeLastPointObject,
        removeFirstPointObject,
        clearSceneObjects,
        removeAllPointObjects,
        screenToWorld,
        dispose,
        camera,
        setSize: resize,
        removeLastLine,
        getLineCount,
    } as any;
}
