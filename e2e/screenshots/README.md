# E2E 截图归档

此目录存放 Playwright E2E 测试产出的截图，包含两类：

## 1. 用例主动截图（手动归档）

各用例调用 `archiveScreenshot(name)` 主动保存的 PNG，文件名形如：

- `01-home.png` — 用例 1 首页加载
- `02-chat-sse.png` — 用例 2 chat 流式响应后
- `03-terminal-pty.png` — 用例 3 PTY 输出后
- `05-home-fullpage.png` — 用例 5 首屏归档
- `05-home-dark.png` — 用例 5 暗色主题归档

每次用例通过都会刷新；仅供人工 review 使用。

## 2. 视觉回归 baseline（`toHaveScreenshot` 自动产出）

文件名形如 `04-platform-degradation-chrome-system.png`，由 Playwright 自动生成。

- **首次跑**：Playwright 生成 baseline，断言通过
- **后续跑**：与 baseline 做像素 diff；差异超过 `maxDiffPixelRatio: 0.01` 则失败

### 更新 baseline

页面 UI 故意变更时：

```bash
bun run e2e:update
# 等价于：
bunx playwright test --update-snapshots
```

更新后请人工 review diff 再提交。

## 注意事项

- baseline 是 chrome-system project 的产物，文件名带 `chrome-system` 后缀
- 本机 vs CI 的 OS/字体差异可能造成 baseline 不稳；目前未接入 CI，按本地基线为准
