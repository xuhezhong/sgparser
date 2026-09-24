# 南网报文解析工具（sgparser）

解析南网上行规约 Q/CSG1209022-2019《计量自动化终端上行通信规约》报文的离线网页工具。

## 使用

1. 下载 `dist/南网报文解析.html`，用 Chrome、Edge 或 Safari 打开（双击即可，不需要网络，报文只在本机处理）。
2. 在「报文内容」里粘贴一帧 hex（空格、换行、`0x`、逗号都可以），会自动解析。
3. 鼠标悬停在字段行上，上方 hex 视图会高亮对应字节；点 ▾ / ▸ 折叠或展开。

说明列里的标记：

- 【…】红字：错误（CS 错、长度不符、数据不足等）。
- 〔规约未要求，按长度推断〕〔按启发式切分〕：工具的推断，不是规约明文。
- 「规约外数据 N 字节」：按规约拆完后剩下的字节，常见于厂家扩展。
- `Pn=72（代码点号 71）`：前者是规约的测量点号，后者是平台代码内部使用的点号（= Pn − 1）。

### 桌面版

不想用浏览器打开的，可以用桌面版（内容与网页版完全相同，同样不联网）：

- Mac：解压 `南网报文解析-<版本>-mac.zip`，把 `南网报文解析.app` 拖进「应用程序」。第一次打开会提示无法验证开发者，到「系统设置 → 隐私与安全性」点「仍要打开」；或在终端执行 `xattr -dr com.apple.quarantine /Applications/南网报文解析.app` 后再打开。
- Windows：直接运行 `南网报文解析-<版本>-win_x64.exe`。如果弹出「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。需要系统自带的 WebView2（Windows 10/11 一般已有）。
- Linux：用网页版。

## 覆盖范围

- 帧层：68 L L 68、控制域、地址域（含 cid）、AFN、SEQ、PW、Tp、CS。
- DI：规约附录中的全部 DI（约 7000 个）都有名称和字节数，可以正确切分，简单格式直接解码；平台常用 DI 和告警精校到字段；水表等平台自有 DI 按平台代码解析。
- 不做：批量或多帧解析、组帧发送、中继内嵌 645 帧、任务数据内容的字段级解析。

## 已知限制

- 水表档案 E080000F：平台按 14 位水表地址组包，每个测量点 30 字节，工具按规约 29 字节解析，末尾 1 字节会显示为规约外数据。
- AFN=0D 应答里多个时间点的切分用的是启发式，目前没有真实样例验证。

## 维护（开发者）

构建与测试：

```bash
node build.mjs
node --test 'test/*.test.mjs'
```

重新生成 DI 字典（需要规约 PDF 和 `gen/requirements.txt` 中的依赖，建议装在仓库外的虚拟环境里）：

```bash
python3 -m venv /tmp/sgparser-venv && /tmp/sgparser-venv/bin/pip install -r gen/requirements.txt
/tmp/sgparser-venv/bin/python gen/extract_di.py --pdf <规约 PDF 路径>
```

- 修正只写在 `gen/overrides.json`，每条都要带 `why`；不要手改 `src/di_dict.js`（首行有哨兵）。
- `gen/review.tsv` 是待人工处理清单，「已处理」列由生成器根据 overrides 计算。
- 提交前可以用 `--check` 确认生成物与仓库一致。
- 重新导入回归语料：`/tmp/sgparser-venv/bin/python gen/import_corpus.py --xls <报文查询.xls> --frame <terminal.frame>`。
- 现网报文（回归语料、真实报文对标用例）只放本地 `test/fixtures/private/`，不入库；没有这个目录时，依赖它的用例自动跳过。入库的样例报文里，集中器地址、表号、主站 IP 都已换成假值。

打包桌面版（只能在 macOS 上执行，壳程序为 Neutralinojs 6.9.0）：

```bash
cd desktop && npm ci && node pack.mjs
```

- 产物在 `desktop/out/`：`南网报文解析-<版本>-mac.zip`（Apple 芯片与 Intel 通用）和 `南网报文解析-<版本>-win_x64.exe`。产物不入库，发布到 GitLab Releases 或共享盘。
- 版本号改 `desktop/neutralino.config.json` 的 `version`。
- 第一次打包会从 GitHub 下载 Neutralino 壳程序（约 8 MB）到 `desktop/bin/`。下载失败时，手工下载 `neutralinojs-v6.9.0.zip`（GitHub neutralinojs/neutralinojs 仓库的 v6.9.0 Release），把其中的 `neutralino-*` 文件解压到 `desktop/bin/` 再重跑。
- Mac 版只做了本机签名（ad-hoc），所以同事第一次打开会被系统拦一次；要去掉这个提示，需要 Apple 开发者账号做公证。
- 桌面版页面是在 dist 页面末尾注入 `neutralino.js`（官方前端库）和 `desktop/desktop.js`（菜单栏、关闭按钮处理）。原生接口只放行 `app.exit` 和 `window.setMainMenu`，不要关掉：Neutralino 6.9.0 在 macOS 上不开原生接口时，点关闭按钮会崩溃；没有菜单栏时 ⌘V 等快捷键无效。
