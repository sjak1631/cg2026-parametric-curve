import * as THREE from "three";
import { bernsteinBasis } from "./util";

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

        const p01: THREE.Vector3 = new THREE.Vector3(
            inv_t * p0.x + t * p1.x,
            inv_t * p0.y + t * p1.y,
        );

        const p12: THREE.Vector3 = new THREE.Vector3(
            inv_t * p1.x + t * p2.x,
            inv_t * p1.y + t * p2.y,
        );

        points.push(new THREE.Vector3(
            inv_t * p01.x + t * p12.x,
            inv_t * p01.y + t * p12.y,
        ));
    }

    return points;
}

export function generateBezierCurvePolynomialN(
    controlPoints: THREE.Vector3[],
    degree: number,
    segments: number = 50
): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;

        let x: number = 0;
        let y: number = 0;
        for (let j = 0; j <= degree; j++) {
            const basis = bernsteinBasis(degree, j, t);
            x += basis * controlPoints[j].x;
            y += basis * controlPoints[j].y;
        }

        points.push(new THREE.Vector3(
            x,
            y,
        ));
    }
    return points;
}

export function generateBezierCurveCasteljauN(
    controlPoints: THREE.Vector3[],
    degree: number,
    segments: number = 50
): THREE.Vector3[] {
    let points: THREE.Vector3[] = [];

    if (degree == 2) {
        points = generateBezierCurveCasteljau(
            controlPoints[0],
            controlPoints[1],
            controlPoints[2],
            segments
        );
    } else {
        const left = controlPoints.slice(0, degree);
        const right = controlPoints.slice(1, degree + 1);

        const left_curve = generateBezierCurveCasteljauN(left, degree - 1, segments);
        const right_curve = generateBezierCurveCasteljauN(right, degree - 1, segments);
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const inv_t = 1 - t;
            points.push(new THREE.Vector3(
                inv_t * left_curve[i].x + t * right_curve[i].x,
                inv_t * left_curve[i].y + t * right_curve[i].y,
            ))
        }
    }


    return points;
}

export function generateCatmullRomSplineSegment(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    t0: number,
    t1: number,
    t2: number,
    t3: number,
    segments: number = 50
): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];

    const start = t1;
    const end = t2;

    for (let i = 0; i <= segments; i++) {
        const t = start + (end - start) * (i / segments);

        const A1: THREE.Vector3 = p0.clone().multiplyScalar((t1 - t) / (t1 - t0)).add(p1.clone().multiplyScalar((t - t0) / (t1 - t0)));
        const A2: THREE.Vector3 = p1.clone().multiplyScalar((t2 - t) / (t2 - t1)).add(p2.clone().multiplyScalar((t - t1) / (t2 - t1)));
        const A3: THREE.Vector3 = p2.clone().multiplyScalar((t3 - t) / (t3 - t2)).add(p3.clone().multiplyScalar((t - t2) / (t3 - t2)));

        const B1: THREE.Vector3 = A1.clone().multiplyScalar((t2 - t) / (t2 - t0)).add(A2.clone().multiplyScalar((t - t0) / (t2 - t0)));
        const B2: THREE.Vector3 = A2.clone().multiplyScalar((t3 - t) / (t3 - t1)).add(A3.clone().multiplyScalar((t - t1) / (t3 - t1)));

        points.push(B1.clone().multiplyScalar((t2 - t) / (t2 - t1)).add(B2.clone().multiplyScalar((t - t1) / (t2 - t1))));
    }

    return points;
}

export const generateBezierCurve = generateBezierCurvePolynomial;
