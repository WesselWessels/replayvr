import basicSsl from '@vitejs/plugin-basic-ssl'
import wasmPlugin from 'vite-plugin-wasm'

export default {
  plugins: [basicSsl(), wasmPlugin()],
  server: {
    https: true,
    host: true,
  },
}
