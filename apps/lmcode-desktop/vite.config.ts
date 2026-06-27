import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const appRoot = import.meta.dirname

export default defineConfig({
  main: {
    build: {
      // Main is built by esbuild via npm script, not electron-vite
      emptyOutDir: false
    }
  },
  preload: {
    build: {
      // Preload is built by esbuild via npm script
      emptyOutDir: false
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve(appRoot, 'src/renderer')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
