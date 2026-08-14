import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createRendererContentSecurityPolicy } from './src/main/security'

const rendererRoot = resolve(import.meta.dirname, 'src/renderer')
const CONTENT_SECURITY_POLICY_PATTERN =
  /(<meta http-equiv="Content-Security-Policy" content=")[^"]*(" \/>)/

function contentSecurityPolicyPlugin(isDevelopment: boolean): Plugin {
  const rendererUrl = isDevelopment ? 'http://localhost:5173/' : 'file:///index.html'
  const policy = createRendererContentSecurityPolicy(rendererUrl, isDevelopment)
  return {
    name: 'lmcode-renderer-content-security-policy',
    transformIndexHtml(html) {
      if (!CONTENT_SECURITY_POLICY_PATTERN.test(html)) {
        throw new Error('Renderer HTML is missing its Content-Security-Policy meta tag')
      }
      return html.replace(CONTENT_SECURITY_POLICY_PATTERN, `$1${policy}$2`)
    },
  }
}

export default defineConfig(({ command }) => ({
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
  plugins: [contentSecurityPolicyPlugin(command === 'serve'), react(), tailwindcss()]
}))
