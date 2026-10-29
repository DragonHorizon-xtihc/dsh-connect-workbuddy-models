import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `.tsx` 用例渲染 React 组件（按文件 `@vitest-environment jsdom` 编译指示走
    // jsdom）。卡片就地渲染 **真实实现**（src/client/*.tsx），不使用手抄镜像 ——
    // 镜像会静默漂移，让一个坏掉的行为照样通过。
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/lib/**'],
    environment: 'node',
    // Windows CI 冷启动时单个文件的首个测试可能显著变慢，抬高默认超时避免抖动
    // 误报；真正挂死的用例仍会失败，只是更晚一点。
    testTimeout: 20_000,
  },
})
