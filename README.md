# cg2026-parametric-curve
Created with CodeSandbox

## Setup (npm)

### 1. Install dependencies

```bash
npm install --legacy-peer-deps
```

This project uses `react-scripts@5` and `typescript@5`, so `--legacy-peer-deps` is required for installation.

### 2. Start development server

```bash
npm start
```

Open: http://localhost:3000

### 3. Production build

```bash
npm run build
```

## GitHub Pages Deployment

### Manual Deployment

To manually deploy to GitHub Pages:

```bash
npm run deploy
```

This command:
1. Builds the production version (`npm run build`)
2. Pushes the `build/` directory to the `gh-pages` branch
3. GitHub automatically publishes it at: https://sjak1631.github.io/cg2026-parametric-curve/

### Automatic Deployment

GitHub Actions automatically deploys to GitHub Pages when you push to the `main` branch. The workflow is defined in `.github/workflows/deploy.yml`.

**Required Setup:**
- Ensure GitHub Pages is enabled in repository settings (Settings → Pages)
- Select "Deploy from a branch" and choose the `gh-pages` branch as the source

## Troubleshooting

- If `npm: command not found` appears, make sure Node.js (npm) is loaded in your shell.
- If dependencies are broken, try reinstalling:

```bash
rm -rf node_modules package-lock.json
npm install --legacy-peer-deps
```
