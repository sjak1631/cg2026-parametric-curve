import * as THREE from "three";

export function generateBezierCurvePolynomial(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    segments: number = 50
): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const inv_t = 1 - t;
        points.push(new THREE.Vector3(
            inv_t * inv_t * p0.x + 2 * t * inv_t * p1.x + t * t * p2.x,
            inv_t * inv_t * p0.y + 2 * t * inv_t * p1.y + t * t * p2.y,
        ));
    }
    return points;
}

export function generateBezierCurveCasteljau(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    segments: number = 50
): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const inv_t = 1 - t;

        points.push(new THREE.Vector3(
            inv_t * p0.x + t * p2.x,
            inv_t * p0.y + t * p2.y,
            inv_t * p0.z + t * p2.z,
        ));
    }

    return points;
}

export const generateBezierCurve = generateBezierCurvePolynomial;
