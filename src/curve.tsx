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

        const p01: THREE.Vector3 = new THREE.Vector3(
            t * p0.x + inv_t * p1.x,
            t * p0.y + inv_t * p1.y,
        );

        const p12: THREE.Vector3 = new THREE.Vector3(
            t * p1.x + inv_t * p2.x,
            t * p1.y + inv_t * p2.y,
        );

        points.push(new THREE.Vector3(
            t * p01.x + inv_t * p12.x,
            t * p01.y + inv_t * p12.y,
        ));
    }

    return points;
}

// --- n次 (degree-N) ひな型関数 ---
// 実際の実装はユーザー側で行う想定のため、ここでは型と簡単なフェイルセーフ実装のみ用意します。
export function generateBezierCurvePolynomialN(
    controlPoints: THREE.Vector3[],
    segments: number = 50
): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    // フェイルセーフ: 制御点が2点以上あれば直線で補間して返す（実装を差し替えてください）
    if (controlPoints.length >= 2) {
        const p0 = controlPoints[0];
        const pN = controlPoints[controlPoints.length - 1];
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            points.push(new THREE.Vector3(
                p0.x * (1 - t) + pN.x * t,
                p0.y * (1 - t) + pN.y * t
            ));
        }
    }
    return points;
}

export function generateBezierCurveCasteljauN(
    controlPoints: THREE.Vector3[],
    segments: number = 50
): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    // フェイルセーフ: ここもユーザー実装用のスタブです。現状は先頭と末尾の直線補間を返します。
    if (controlPoints.length >= 2) {
        const p0 = controlPoints[0];
        const pN = controlPoints[controlPoints.length - 1];
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            points.push(new THREE.Vector3(
                p0.x * (1 - t) + pN.x * t,
                p0.y * (1 - t) + pN.y * t
            ));
        }
    }
    return points;
}

export const generateBezierCurve = generateBezierCurvePolynomial;
