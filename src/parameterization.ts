import * as THREE from "three";

/**
 * ノット列・パラメータ値の計算方式
 * - "uniform": 均等分割（デフォルト）
 * - "chordal": 制御点間の距離に基づく（chord-length parameterization）
 * - "centripetal": 距離の平方根を使う（中間的なアプローチ）
 */
export type ParametrizationType = "uniform" | "chordal" | "centripetal";

/**
 * 制御点列からパラメータ値を計算する（incremental 方式）
 * catmull_rom_parameter の logic を一般化
 */
export function createParameterValues(
    controlPoints: THREE.Vector3[],
    type: ParametrizationType = "uniform"
): number[] {
    const values: number[] = [0];

    if (type === "uniform") {
        // uniform: インデックスをそのまま使用
        for (let i = 1; i < controlPoints.length; i++) {
            values.push(i);
        }
    } else if (type === "chordal") {
        // chordal: 距離の累積
        for (let i = 1; i < controlPoints.length; i++) {
            const distance = controlPoints[i].distanceTo(controlPoints[i - 1]);
            values.push(values[i - 1] + distance);
        }
    } else if (type === "centripetal") {
        // centripetal: 距離の平方根の累積
        for (let i = 1; i < controlPoints.length; i++) {
            const distance = controlPoints[i].distanceTo(controlPoints[i - 1]);
            values.push(values[i - 1] + Math.sqrt(distance));
        }
    }

    return values;
}

/**
 * Clamped knot vector をパラメータ化方式に応じて生成
 * NURBS の曲線評価用
 *
 * @param controlPointCount 制御点数
 * @param degree 次数
 * @param controlPoints 制御点列（chordal/centripetal 用；uniform の場合は null 可）
 * @param type パラメータ化方式
 * @returns ノット列
 */
export function createClampedKnotVector(
    controlPointCount: number,
    degree: number,
    controlPoints?: THREE.Vector3[],
    type: ParametrizationType = "uniform"
): number[] {
    const knots: number[] = [];
    const n = controlPointCount - 1;
    const p = Math.min(degree, n);

    // 前半 p+1 個の 0
    for (let i = 0; i <= p; i++) {
        knots.push(0);
    }

    // 内部ノット
    const internalKnotCount = n - p;
    let internalKnots: number[] = [];

    if (type === "uniform") {
        // uniform: 均等分割
        for (let i = 1; i <= internalKnotCount; i++) {
            internalKnots.push(i / (internalKnotCount + 1));
        }
    } else if (controlPoints && controlPoints.length === controlPointCount) {
        // chordal or centripetal
        const paramValues = createParameterValues(controlPoints, type);
        const tMax = paramValues[paramValues.length - 1];

        // 各制御点に対応する パラメータ値を [0, 1] に正規化
        const normalized = paramValues.map((t) => t / tMax);

        // 内部ノットは、各セグメントの "representative" パラメータ値
        // 通常は次のようにして計算: knots[p+j] = (t[j] + t[j+1] + ... + t[j+p-1]) / p
        for (let j = 1; j <= internalKnotCount; j++) {
            let sum = 0;
            for (let k = 0; k < p; k++) {
                sum += normalized[j + k - 1];
            }
            internalKnots.push(sum / p);
        }
    } else {
        // fallback to uniform
        for (let i = 1; i <= internalKnotCount; i++) {
            internalKnots.push(i / (internalKnotCount + 1));
        }
    }

    knots.push(...internalKnots);

    // 後半 p+1 個の 1
    for (let i = 0; i <= p; i++) {
        knots.push(1);
    }

    return knots;
}
