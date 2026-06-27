import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const rendererRoot = resolve(import.meta.dirname, 'src/renderer')

export default defineConfig({
  root: rendererRoot,
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, 'out/renderer'),
    emptyOutDir: true
  },
  resolve: {
    alias: {
      '@': rendererRoot
    }
  },
  plugins: [react(), tailwindcss()]
})
