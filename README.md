# Jev Skill Router

Pi 原生 TypeScript 扩展。每条正常用户请求用 Jev 对本地技能 metadata
做独立 Noul 判断，再把本轮技能交给 Pi 原生 formatter 和正文读取流程。

## 首版边界

- 复用 Pi 技能发现、原路径和显式 `/skill:name`，无需关闭磁盘扫描。
- 每轮替换自动目录，同一轮工具续跑沿用选择；用户固定项始终优先。
- 正常零命中保留空自动目录；服务错误明确提示并回退原始目录。
- 首版不支持运行中插话、接管已有历史会话、其他 harness 或清除历史正文。
- 兼容基线：`@earendil-works/pi-coding-agent@1.3.0`。需求源码基线：
  [`482c1381`](https://github.com/earendil-works/pi/tree/482c1381a00d8d00bc81697e4a980c593db6803e)。

## 开发

Node.js >=22.19，建议 Node.js 24。`npm ci` 安装依赖，`npm run check`
执行类型检查、Lint、测试和构建。构建输出在 `dist/`。

第一阶段已验证：原生发现的技能目录可按轮替换；实际 HTTP provider payload
只包含选择项和固定项；真实 `read` 工具续跑保持目录；显式技能正文仍由 Pi
加载，选择器保留展开前的输入。测试使用临时本机服务，不消耗线上凭据。

当前默认入口仍是保守的全量目录原型；下一阶段接入 Jev 与配置后提供安装说明。
