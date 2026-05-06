export function bernsteinBasis(n: number, j: number, t: number): number {
    let binomial = 1;
    for (let i = 0; i < j; i++) {
        binomial *= (n - i) / (i + 1);
    }

    const tj = Math.pow(t, j);
    const inv_t_n_minus_j = Math.pow(1 - t, n - j);

    return binomial * tj * inv_t_n_minus_j;
}
