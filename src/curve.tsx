import * as THREE from "three";

export function bezierPoint(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    t: number
): THREE.Vector3 {
    const inv_t = 1 - t;
    return new THREE.Vector3(
        inv_t * p0.x + t * p2.x,
        inv_t * p0.y + t * p2.y,
        inv_t * p0.z + t * p2.z
    );
}

export function generateBezierCurve(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    segments: number = 50
): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        points.push(bezierPoint(p0, p1, p2, t));
    }
    return points;
}
