import * as THREE from "three";

class CatmullRomBaseParameter {
    private currentT = 0;

    next(_currentPoint: THREE.Vector3, _previousPoint: THREE.Vector3): number {
        return this.currentT++;
    }

    reset(): void {
        this.currentT = 0;
    }

    value(): number {
        return this.currentT;
    }

    set(value: number): void {
        this.currentT = value;
    }
}

export class CatmullRomUniformParameter extends CatmullRomBaseParameter { }

export class CatmullRomChordalParameter extends CatmullRomBaseParameter {
    next(currentPoint: THREE.Vector3, previousPoint: THREE.Vector3): number {
        const current = this.value();
        this.set(current + currentPoint.distanceTo(previousPoint));
        return this.value();
    }
}

export class CatmullRomCentripetalParameter extends CatmullRomBaseParameter {
    next(currentPoint: THREE.Vector3, previousPoint: THREE.Vector3): number {
        const current = this.value();
        this.set(current + Math.sqrt(currentPoint.distanceTo(previousPoint)));
        return this.value();
    }
}
