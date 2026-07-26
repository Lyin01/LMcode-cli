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
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'zustand'],
          'markdown-vendor': ['react-markdown', 'remark-gfm', 'rehype-highlight'],
          'ui-vendor': ['lucide-react', '@radix-ui/react-dialog', '@radix-ui/react-select']
        }
      }
    }
  },
  resolve: {
    alias: {
      '@': rendererRoot
    }
  },
  plugins: [react(), tailwindcss()]
})
