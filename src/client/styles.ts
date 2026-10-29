/**
 * 浏览器半区的内联样式，两段：设置卡片（`WB_MODELS_CARD_CSS`）与输入框读数
 * （`WB_MODELS_COMPOSER_CSS`）。
 *
 * ## 为什么是内联 CSS 而不是 CSS 文件
 *
 * 客户端 bundle 由宿主 `__ModuleLoader__` 以 CJS 形式求值，没有 CSS loader，也
 * 没有可发布的 `.css` 产物（`package.json` 的 `files` 只有 `lib/`），所以样式只能
 * 以字符串形式随 JS 一起走。
 *
 * ## 为什么类名一律 `wbm-` 前缀
 *
 * `dsm-*` 是社区插件之间的事实约定（`dsh-connect-workbuddy`、
 * `dsh-connect-trae-models`、`dsh-workbuddy-xdpool` 都用它），但**同一前缀不等于
 * 同一份规则**：三家各自定义 `.dsm-btn` 与 `.dsm-plugin-card`，谁后注入谁赢，于是
 * 「本插件的卡片外观」取决于用户的插件安装顺序。所以：
 *
 *  - 视觉**原语**（按钮 `.dsm-btn*`、卡片外壳 `.dsm-plugin-card*`）继续用 `dsm-*`，
 *    与邻居共享同一套外部表现语言，这是刻意的；
 *  - 本插件**自己的**结构类（账号行、模型行、读数、面板）一律 `wbm-` 前缀，
 *    永远不会被另一个插件的同名规则改掉。面板的 `position: fixed` 尤其重要：
 *    参考项目曾因为面板没拿到 `position: fixed` 而把测好的 left/top 当作无效值，
 *    面板渲染在「任何地方都不在」的位置上。
 *
 * 主题色一律走宿主变量 `--dsw-alias-*`，并给出十六进制回退值——受限宿主上变量
 * 可能不存在，此时界面必须仍然可读，而不是变成黑底黑字。
 *
 * @module dsh-connect-workbuddy-models/client/styles
 */

/** 设置卡片样式。 */
export const WB_MODELS_CARD_CSS = `
/* ── 页面外壳 ───────────────────────────────────────────────────────────── */
.wbm-page{display:flex;flex-direction:column;gap:16px;padding:16px 0 8px}
.wbm-page-head{display:flex;align-items:flex-start;gap:16px;justify-content:space-between}
.wbm-page-copy{display:flex;flex-direction:column;gap:6px;min-width:0}
.wbm-page-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:16px;font-weight:600;line-height:1.4}
.wbm-page-desc{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}
.wbm-page-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}

/* ── 卡片 ───────────────────────────────────────────────────────────────── */
.wbm-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.wbm-section-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:1.4;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wbm-section-hint{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.5}
.wbm-muted{color:var(--dsw-alias-label-tertiary,#999);font-size:12px}
.wbm-secondary{color:var(--dsw-alias-label-secondary,#c8c8c8);font-size:13px}
.wbm-error{color:var(--dsw-alias-label-danger,#ff6b6b);font-size:12px;margin:0;line-height:1.5}
.wbm-warn{color:var(--dsw-alias-label-warning,#f0a23c);font-size:12px}
.wbm-ok{color:var(--dsw-alias-label-success,#4ec07a);font-size:12px}

/* ── 账号行 ─────────────────────────────────────────────────────────────── */
.wbm-account{border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:10px;display:flex;flex-direction:column;gap:6px}
.wbm-account:first-of-type{border-top:0;padding-top:0}
.wbm-account-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wbm-account-name{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbm-account-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:12px}
.wbm-account-path{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;overflow-wrap:anywhere}
.wbm-account-facts{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#c8c8c8)}

/* 标签胶囊。四种语气各自一条规则：颜色表达的是「要不要处理」。 */
.wbm-tag{display:inline-flex;align-items:center;border-radius:6px;padding:1px 6px;font-size:11px;line-height:1.6;border:1px solid transparent;white-space:nowrap}
.wbm-tag-ok{color:var(--dsw-alias-label-success,#4ec07a);border-color:var(--dsw-alias-label-success,#4ec07a)}
.wbm-tag-warn{color:var(--dsw-alias-label-warning,#f0a23c);border-color:var(--dsw-alias-label-warning,#f0a23c)}
.wbm-tag-danger{color:var(--dsw-alias-label-danger,#ff6b6b);border-color:var(--dsw-alias-label-danger,#ff6b6b)}
.wbm-tag-neutral{color:var(--dsw-alias-label-tertiary,#999);border-color:var(--dsw-alias-border-l2,#36373b)}

/* 临期提醒：整行高亮，而不是只给数字染色——用户扫的是一行，不是一位数。 */
.wbm-expiry{display:flex;align-items:center;gap:6px;font-size:12px;line-height:1.5;border-radius:6px;padding:3px 8px}
.wbm-expiry-soon{color:var(--dsw-alias-label-warning,#f0a23c);background:rgba(240,162,60,.12);border:1px solid rgba(240,162,60,.35)}
.wbm-expiry-future{color:var(--dsw-alias-label-tertiary,#999)}
.wbm-expiry-none{color:var(--dsw-alias-label-tertiary,#999)}

/* ── 积分包明细 ─────────────────────────────────────────────────────────── */
/* 折叠按钮长得像链接而不是按钮：它不改变任何状态，只多露出几行文字。 */
.wbm-packages{display:flex;flex-direction:column;gap:4px}
.wbm-packages-toggle{appearance:none;font:inherit;font-size:12px;color:var(--dsw-alias-brand-primary,#5686fe);background:transparent;border:0;border-radius:6px;padding:2px 0;text-align:left;cursor:pointer}
.wbm-packages-toggle:hover{text-decoration:underline}
.wbm-packages-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:2px}
/* 上限高度 + 纵向滚动：实测一个账号可以有 59 个包，展开后必须不把下面的签到按钮
   顶出屏幕，也不能让整页跟着一起滚。 */
.wbm-packages-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:220px;overflow-y:auto}
.wbm-packages-row{display:flex;align-items:baseline;gap:8px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#c8c8c8);border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:2px}
.wbm-packages-row:first-child{border-top:0;padding-top:0}
/* 包名可能很长（「CodeBuddy个人版国内运营裂变包」），让它占满剩余宽度并折行，
   而不是把数量和时间挤出去。 */
.wbm-packages-name{flex:1;min-width:0;overflow-wrap:anywhere}
/* 数量与时间不折行：88.05 / 100 断成两行就读不出「还剩多少 / 总量」了。
   注意这段是 TypeScript 模板字符串，注释里不能出现反引号，会提前终止字符串。 */
.wbm-packages-amount{flex:none;white-space:nowrap;font-variant-numeric:tabular-nums}

/* ── 开关与字段 ─────────────────────────────────────────────────────────── */
.wbm-toggle{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#c8c8c8);cursor:pointer}
.wbm-toggle input{accent-color:var(--dsw-alias-brand-primary,#5686fe);cursor:pointer}
.wbm-toggle input:disabled{cursor:default}
.wbm-field{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#c8c8c8)}
.wbm-field select,.wbm-field input[type=number]{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-2,#25262b);border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:6px;padding:2px 6px}
.wbm-field select:focus-visible,.wbm-field input[type=number]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.wbm-hours{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
.wbm-hour{appearance:none;font:inherit;font-size:11px;cursor:pointer;min-width:34px;padding:2px 4px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:transparent;color:var(--dsw-alias-label-tertiary,#999)}
.wbm-hour:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}
.wbm-hour-on{color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-brand-primary,#5686fe);background:rgba(86,134,254,.16)}
.wbm-hour:disabled{opacity:.4;cursor:default}

/* ── 使用方式（单选组）───────────────────────────────────────────────────── */
.wbm-choices{display:flex;flex-direction:column;gap:6px}
.wbm-choice{display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px;border-radius:8px;border:1px solid transparent}
.wbm-choice:hover{border-color:var(--dsw-alias-border-l2,#36373b);background:rgba(255,255,255,.02)}
.wbm-choice input{margin-top:2px;accent-color:var(--dsw-alias-brand-primary,#5686fe);cursor:pointer}
.wbm-choice-body{display:flex;flex-direction:column;gap:2px;min-width:0}
.wbm-choice-label{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:1.4}
/* 被选中的那条用强调色，好让「现在用的是哪种」一眼可见（单选组只有一处选中）。 */
.wbm-choice-on .wbm-choice-label{color:var(--dsw-alias-brand-primary,#5686fe);font-weight:600}
.wbm-choice-hint{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.5}

/* ── 模型行 ─────────────────────────────────────────────────────────────── */
.wbm-model{display:flex;align-items:flex-start;gap:8px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:8px}
.wbm-model:first-of-type{border-top:0;padding-top:0}
.wbm-model input[type=checkbox]{margin-top:3px;accent-color:var(--dsw-alias-brand-primary,#5686fe);cursor:pointer}
.wbm-model input[type=checkbox]:disabled{cursor:default}
.wbm-model-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.wbm-model-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wbm-model-name{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbm-model-facts{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px}
.wbm-model-id{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);overflow-wrap:anywhere}

/* ── 跳过文件 ───────────────────────────────────────────────────────────── */
.wbm-skipped{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:10px}
.wbm-skipped-row{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999)}
.wbm-skipped-path{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;overflow-wrap:anywhere;flex:none;max-width:50%}

/* ── 空态 ───────────────────────────────────────────────────────────────── */
.wbm-empty{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px dashed var(--dsw-alias-border-l2,#36373b);border-radius:8px}
.wbm-empty-title{margin:0;color:var(--dsw-alias-label-secondary,#c8c8c8);font-size:13px;font-weight:600}
.wbm-empty-note{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.5}
`

/**
 * 输入框读数的样式。
 *
 * 单独一段，且由 `ComposerCredits.tsx` 在**模块求值阶段**就注入：设置卡片可能
 * 永远不被渲染（用户没打开设置面板），而读数要立刻可用。参考项目当年就是把两段
 * 揉在一起，结果读数在没有卡片渲染的宿主上渲染成一个默认按钮框。
 */
export const WB_MODELS_COMPOSER_CSS = `
/* 触发按钮：一行纯读数，没有任何额外控件——这一行与外壳自己的权限/模型控件共享
 * 宽度，每多一个按钮都是别人的空间。手动刷新放在面板里。 */
.wbm-composer-credits{display:inline-flex;align-items:center;min-width:0}
.wbm-composer-trigger{appearance:none;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:4px;border:1px solid transparent;border-radius:6px;padding:2px 6px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#999);background:transparent;white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}
.wbm-composer-trigger:hover{color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-border-l2,#36373b);background:rgba(255,255,255,.04)}
.wbm-composer-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.wbm-composer-trigger[aria-expanded=true]{color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}
.wbm-composer-amount{color:var(--dsw-alias-label-secondary,#c8c8c8)}
.wbm-composer-user{color:var(--dsw-alias-label-tertiary,#999);max-width:14ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbm-composer-stale{color:var(--dsw-alias-label-warning,#f0a23c)}

/* 锚定面板。position: fixed 是必须的——缺了它，JS 测出来的 left/top 对绝对定位
 * 元素无效，面板会渲染到「哪儿都不在」。 */
.wbm-composer-panel{position:fixed;z-index:60;min-width:260px;max-width:340px;display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-2,#25262b);box-shadow:0 8px 28px rgba(0,0,0,.4)}
.wbm-composer-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.wbm-composer-panel-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px;font-weight:600}
.wbm-composer-panel-refresh{appearance:none;font:inherit;font-size:11px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#999);padding:1px 8px}
.wbm-composer-panel-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}
.wbm-composer-panel-refresh:disabled{opacity:.4;cursor:default}
.wbm-composer-panel-empty{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.5}
.wbm-composer-panel-table{width:100%;border-collapse:collapse;font-size:12px}
.wbm-composer-panel-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary,#999);padding:2px 4px;border-bottom:1px solid var(--dsw-alias-border-l2,#36373b);font-size:11px}
.wbm-composer-panel-table td{padding:2px 4px;color:var(--dsw-alias-label-secondary,#c8c8c8);vertical-align:top}
.wbm-composer-panel-num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.wbm-composer-panel-row-current td{color:var(--dsw-alias-label-primary,#e6e6e6)}
/* 行内按钮铺满单元格，让整行都可点——点行切换账号，不点小圆点。 */
.wbm-composer-row-switch{appearance:none;font:inherit;cursor:pointer;display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:0;border-radius:6px;background:transparent;color:inherit;padding:3px 4px;min-width:0}
.wbm-composer-row-switch:hover:not(:disabled){background:rgba(255,255,255,.06)}
.wbm-composer-row-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-2px}
.wbm-composer-row-switch:disabled{cursor:default}
.wbm-composer-row-who{display:flex;flex-direction:column;gap:1px;min-width:0}
.wbm-composer-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:16ch}
.wbm-composer-row-mark{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}
.wbm-composer-row-mark-current{color:var(--dsw-alias-label-success,#4ec07a)}
.wbm-composer-panel-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:6px}
.wbm-composer-panel-error{margin:0;color:var(--dsw-alias-label-warning,#f0a23c);font-size:11px;line-height:1.5}
`
