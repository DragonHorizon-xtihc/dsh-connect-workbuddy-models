import { defineConfig } from 'tsdown'
const PLUGIN_ID = 'dsh-connect-workbuddy-models'
const CLIENT_EXTERNALS = [
  'react','react/jsx-runtime','react-dom','react-dom/client',
  '@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client','@deepseek-ai/dsh-client-ui-primitives',
]
export default defineConfig([
  {
    entry: ['src/client/index.tsx'],
    outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false,
    outExtensions: () => ({ js: '.js' }), sourcemap: false,
    define: { __DSH_WB_MODELS_VERSION__: '"0.1.0"' },
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
