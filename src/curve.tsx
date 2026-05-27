import * as THREE from "three";
import { bernsteinBasis } from "./util";
import { ParametrizationType, createClampedKnotVector } from "./parameterization";

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
    const points: THREE.Vector3[] = [];

    const bx: number[] = new Array(degree + 1);
    const by: number[] = new Array(degree + 1);

    for (let s = 0; s <= segments; s++) {
        const t = s / segments;
        const inv_t = 1 - t;

        for (let i = 0; i <= degree; i++) {
            bx[i] = controlPoints[i].x;
            by[i] = controlPoints[i].y;
        }

        for (let r = 1; r <= degree; r++) {
            for (let i = 0; i <= degree - r; i++) {
                bx[i] = inv_t * bx[i] + t * bx[i + 1];
                by[i] = inv_t * by[i] + t * by[i + 1];
            }
        }

        points.push(new THREE.Vector3(bx[0], by[0]));
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

export function generateNURBSCurve(
    controlPoints: THREE.Vector3[],
    weights?: number[],
    segments: number = 32,
    degree: number = 3,
    knots?: number[],
    parameterization: ParametrizationType = "uniform"
): THREE.Vector3[] {
    if (controlPoints.length < 2) return [];

    const n = controlPoints.length - 1;
    const p = Math.min(degree, n);

    const ws = weights ?? controlPoints.map(() => 1.0);

    if (ws.length !== controlPoints.length) {
        throw new Error("weights.length must match controlPoints.length");
    }

    const U = knots ?? createClampedKnotVector(controlPoints.length, p, controlPoints, parameterization);

    if (U.length !== controlPoints.length + p + 1) {
        throw new Error(
            `Invalid knot vector length. Expected ${controlPoints.length + p + 1}, got ${U.length}`
        );
    }

    const points: THREE.Vector3[] = [];

    const uStart = U[p];
    const uEnd = U[n + 1];

    const spanCount = Math.max(1, n - p + 1);
    const totalSegments = Math.max(1, Math.round(segments * spanCount));

    for (let s = 0; s <= totalSegments; s++) {
        const t = s / totalSegments;
        const u = uStart + (uEnd - uStart) * t;

        points.push(evaluateNURBSPoint(u, controlPoints, ws, U, p));
    }

    return points;
}

function evaluateNURBSPoint(
    u: number,
    controlPoints: THREE.Vector3[],
    weights: number[],
    knots: number[],
    degree: number
): THREE.Vector3 {
    const n = controlPoints.length - 1;

    if (Math.abs(u - knots[n + 1]) < 1e-12) {
        return controlPoints[n].clone();
    }

    let numerator = new THREE.Vector3(0, 0, 0);
    let denominator = 0;

    for (let i = 0; i <= n; i++) {
        const N = bsplineBasis(i, degree, u, knots);
        const wN = weights[i] * N;

        numerator.add(controlPoints[i].clone().multiplyScalar(wN));
        denominator += wN;
    }

    if (Math.abs(denominator) < 1e-12) {
        return new THREE.Vector3(0, 0, 0);
    }

    return numerator.divideScalar(denominator);
}

function bsplineBasis(
    i: number,
    degree: number,
    u: number,
    knots: number[]
): number {
    if (degree === 0) {
        return knots[i] <= u && u < knots[i + 1] ? 1.0 : 0.0;
    }

    let left = 0.0;
    const leftDenom = knots[i + degree] - knots[i];

    if (leftDenom !== 0) {
        left =
            ((u - knots[i]) / leftDenom) *
            bsplineBasis(i, degree - 1, u, knots);
    }

    let right = 0.0;
    const rightDenom = knots[i + degree + 1] - knots[i + 1];

    if (rightDenom !== 0) {
        right =
            ((knots[i + degree + 1] - u) / rightDenom) *
            bsplineBasis(i + 1, degree - 1, u, knots);
    }

    return left + right;
}

export function generateBezierCurveMonomialN(
    controlPoints: THREE.Vector3[],
    degree: number,
    segments: number = 50
): THREE.Vector3[] {

    const C: number[][] = [];
    for (let n = 0; n <= degree; n++) {
        C.push([]);
        for (let k = 0; k <= n; k++) {
            if (k === 0 || k === n) {
                C[n].push(1);
            } else {
                C[n].push(C[n - 1][k - 1] + C[n - 1][k]);
            }
        }
    }

    const ax: number[] = new Array(degree + 1).fill(0);
    const ay: number[] = new Array(degree + 1).fill(0);
    for (let i = 0; i <= degree; i++) {
        let sx = 0;
        let sy = 0;
        for (let j = 0; j <= i; j++) {
            const sign = ((i - j) & 1) ? -1 : 1;
            const coef = sign * C[i][j];
            sx += coef * controlPoints[j].x;
            sy += coef * controlPoints[j].y;
        }
        const outer = C[degree][i];
        ax[i] = outer * sx;
        ay[i] = outer * sy;
    }

    const points: THREE.Vector3[] = [];
    for (let k = 0; k <= segments; k++) {
        const t = k / segments;
        let x = ax[degree];
        let y = ay[degree];
        for (let i = degree - 1; i >= 0; i--) {
            x = x * t + ax[i];
            y = y * t + ay[i];
        }
        points.push(new THREE.Vector3(x, y));
    }
    return points;
}
