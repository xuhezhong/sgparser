// 桌面版打包：把 dist/南网报文解析.html 装进 Neutralino 壳，产出 Mac 与 Windows 的单文件程序（仅支持在 macOS 上执行）
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const APP = '南网报文解析';
const cfg = JSON.parse(readFileSync(join(here, 'neutralino.config.json'), 'utf8'));
const { version } = cfg;
const bin = cfg.cli.binaryName;
const neu = join(here, 'node_modules', '.bin', 'neu');
const run = (cmd, args, cwd = here) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

if (process.platform !== 'darwin') throw new Error('只支持在 macOS 上打包（.app 需要 codesign 签名）');
if (!existsSync(neu)) throw new Error('缺少 neu 命令行，先在 desktop/ 下执行 npm ci');

// 0. 从同一份 SVG 生成各平台图标；只依赖 macOS 自带工具。
const icons = join(here, 'icons');
const iconset = join(icons, 'AppIcon.iconset');
mkdirSync(iconset, { recursive: true });
const logo = readFileSync(join(root, 'src', 'logo.svg'), 'utf8').trim();
if (!/viewBox="0 0 160 160"/.test(logo)) throw new Error('logo 的 viewBox 必须为 0 0 160 160');
const padded = join(icons, 'padded.svg');
writeFileSync(padded, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><g transform="translate(100 100) scale(5.15)">${logo.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</g></svg>`);
try {
  run('sips', ['-s', 'format', 'png', '-z', '256', '256', join(root, 'src', 'logo.svg'), '--out', join(icons, 'app.png')]);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      run('sips', ['-s', 'format', 'png', '-z', pixels, pixels, padded, '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
    }
  }
} catch (cause) {
  throw new Error('图标转换失败：请确认当前 macOS 的 sips 支持读取 SVG（已在 macOS 27 验证）', { cause });
}
run('iconutil', ['-c', 'icns', iconset, '-o', join(icons, 'AppIcon.icns')]);

// 1. 重新生成单文件 HTML，作为壳的唯一页面；末尾注入前端库和壳脚本（菜单栏、关闭处理），网页版 dist 不变
run(process.execPath, [join(root, 'build.mjs')], root);
const res = join(here, 'resources');
mkdirSync(res, { recursive: true });
// 文件名须以 neutralino.js 结尾：壳的内置服务器只给这类文件前置 NL_PORT、NL_TOKEN 等全局变量
copyFileSync(join(here, 'node_modules', '@neutralinojs', 'lib', 'dist', 'neutralino.js'), join(res, 'neutralino.js'));
copyFileSync(join(here, 'desktop.js'), join(res, 'desktop.js'));
const html = readFileSync(join(root, 'dist', `${APP}.html`), 'utf8');
if (html.split('</body>').length !== 2) throw new Error('dist 页面里 </body> 不是恰好一处，无法注入壳脚本');
writeFileSync(join(res, 'index.html'), html.replace('</body>', '<script src="/neutralino.js"></script><script src="/desktop.js"></script></body>'));

// 2. 壳程序按 cli.binaryVersion 从 GitHub 下载到 bin/，已下载则跳过
if (!existsSync(join(here, 'bin', 'neutralino-mac_universal'))) run(neu, ['update']);

// 3. 打包，网页资源嵌进各平台二进制
rmSync(join(here, 'dist'), { recursive: true, force: true });
run(neu, ['build', '--embed-resources']);
const built = join(here, 'dist', bin);

const out = join(here, 'out');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);

// 4. Windows：嵌好资源的 exe 直接可用
const exe = join(out, `${APP}-${version}-win_x64.exe`);
copyFileSync(join(built, `${bin}-win_x64.exe`), exe);

// 5. Mac：neu 的 --macos-bundle 只给文件改名，不是合法的 .app，这里手工组装（universal 二进制兼容 Apple 芯片与 Intel）
const app = join(out, `${APP}.app`);
const exec = join(app, 'Contents', 'MacOS', bin);
mkdirSync(dirname(exec), { recursive: true });
copyFileSync(join(built, `${bin}-mac_universal`), exec);
chmodSync(exec, 0o755);
mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
copyFileSync(join(icons, 'AppIcon.icns'), join(app, 'Contents', 'Resources', 'AppIcon.icns'));
writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleExecutable</key><string>${bin}</string>
  <key>CFBundleIdentifier</key><string>${cfg.applicationId}</string>
  <key>CFBundleName</key><string>${APP}</string>
  <key>CFBundleDisplayName</key><string>${APP}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`);
// 嵌入资源会破坏原有签名，Apple 芯片拒绝运行未签名程序，补本机签名（ad-hoc，不需要开发者账号）
run('codesign', ['--force', '-s', '-', app]);
const zip = join(out, `${APP}-${version}-mac.zip`);
run('ditto', ['-c', '-k', '--keepParent', app, zip]);

for (const f of [zip, exe]) process.stdout.write(`已生成 ${f}（${(statSync(f).size / 1048576).toFixed(1)} MB）\n`);
