# dsh-plugin-image-studio（生图工作台）

给 DSH 加一个「生图」标签：点开就是生图工作台，地址 + Key 可以自己填，任意 OpenAI 兼容的中转站 / 官方 API 都能接，不绑定某一家。

## 现在能做什么（v0.1 UI 原型）

- 会话顶栏一个 **生图** 标签，和「解析」并排。
- 第一次打开是引导卡：填 **接口地址 / API Key / 协议**，旁边有「1route 预设」一键填入。
- 有 Key 之后是工作台：供应商 · 模型 · 尺寸 · 质量 下拉，提示词输入框，参考图拖进来，画笔涂遮罩做局部重绘，右侧出图。
- 设置页有「生图」区块：管理多套供应商、试连、以及**顶栏标签显示/隐藏开关**。

## 数据放哪

- 配置：`~/.dsh/image-studio/config.json`（权限 600，**Key 只存在这台电脑的这个文件里**，插件目录内不含任何密钥；换一台电脑装插件要从头填一次 Key）
- 出图：默认存 **桌面 / HSDGPTimg2.5**（自动创建；桌面被 OneDrive 接管时自动适配，实在找不到桌面就退回 `~/.dsh/image-studio/outputs/`）
- 用量账本：`~/.dsh/image-studio/usage.jsonl`（只记时间、模型、尺寸、张数、估算价）

## 确认是 OpenAI 出图

生成 PNG 里带 C2PA 签名，搜字符串能看到 `softwareAgent ... ChatGPT`、`igpt-image`、`OpenAI OpCo, LLC`、`OpenAI Media Service API`。中转站只是把签名换成自己的（Trufo C2PA Claim Signing CA）。

## 协议说明

- `openai`：`POST {baseUrl}/images/generations`、`POST {baseUrl}/images/edits`（multipart 优先，失败自动回退 JSON `images[].image_url`）。mask = PNG 透明区，尺寸与首图一致。
- `gemini`：`POST {baseUrl}/models/{model}:generateContent`，读 `candidates[].content.parts[].inlineData`。

## 开发

无构建步骤：`client.js` 是手写的 `window.__ModuleLoader__` 工厂，直接改直接生效（刷新页面）。

## 视频画布（实验）

- 顶栏第二个标签「视频画布」，紧跟「生图」。打开默认是**表单模式**（选模型 / 时长 / 分辨率 + 写描述 + 生成），右上角可切「画布（实验）」。
- 生成流程：后端提交 `POST {baseUrl}/videos`，轮询 `GET {baseUrl}/videos/{id}`，完成后**立刻自动下载**到 **桌面 / HSDvideo**（中转站的结果文件只保留约 10 分钟、下载链最长 5 分钟，必须程序自动存）。
- 计费：按条模型（`seedance-2.5-flex-720p` ¥7/条、`full-720p` ¥6.15/条）与按秒模型（`seedance-2.5-stable-a2-720p` ¥0.48/秒）分开估算，界面上显示预估 / 本条约 ¥x。短视频（≤12 秒）按秒更省，长视频按条更省。
- 视频和生图要**不同分组的 Key**（1route：视频走「低价混合」或 `default` 分组），在设置页多加一套供应商即可。
- 画布模式用 React Flow，引擎（React 18 + @xyflow/react 12，约 340KB）**已内嵌进 `client.js`**，不依赖 CDN、也不依赖宿主静态路由。已知问题：部分宿主视图里画布节点点不动，所以默认不在画布模式下工作；表单模式不受影响。重新打包引擎：`cd vendor-build && npx esbuild entry.js --bundle --minify --format=iife --platform=browser --target=es2019 --outfile=../vendor/xyflow.global.js`，再用 `node scripts/embed-vendor.mjs` 内嵌（注意替换必须用函数式，否则 `$` 会被当成替换模式）。

## 安装

```bash
# 在 DSH 里把本目录作为 bundle 装上（link 方式，改代码即生效）
plugin_manager install_bundle target="link:/path/to/dsh-plugin-image-studio"
```

装完刷新页面。配置与密钥只写在本机 `~/.dsh/image-studio/`，插件目录内不含任何密钥。

## 许可

MIT。第三方组件：React 18、React DOM 18、@xyflow/react 12（均为 MIT），以 esbuild 打包形式内嵌于 `vendor/` 与 `client.js`。
