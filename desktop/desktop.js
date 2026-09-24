// 桌面版壳脚本：打包时注入 index.html，网页版不含。依赖先加载的 neutralino.js（官方前端库）
Neutralino.init();

// macOS 的 ⌘V / ⌘C / ⌘A 等快捷键靠菜单栏「编辑」菜单转发给输入框，Neutralino 默认不建菜单栏，所以要补上
Neutralino.window.setMainMenu([
  { id: 'app', text: '南网报文解析', menuItems: [
    { id: 'quit', text: '退出南网报文解析', shortcut: 'q' },
  ] },
  { id: 'edit', text: '编辑', menuItems: [
    { id: 'undo', text: '撤销', action: 'undo:', shortcut: 'z' },
    { id: 'redo', text: '重做', action: 'redo:', shortcut: 'Z' },
    { text: '-' },
    { id: 'cut', text: '剪切', action: 'cut:', shortcut: 'x' },
    { id: 'copy', text: '复制', action: 'copy:', shortcut: 'c' },
    { id: 'paste', text: '粘贴', action: 'paste:', shortcut: 'v' },
    { id: 'selectAll', text: '全选', action: 'selectAll:', shortcut: 'a' },
  ] },
]);

// 红色关闭按钮：壳默认在主线程直接退出，window::_close 对主队列 dispatch_sync 自锁崩溃；
// 配置里开原生接口并设 exitProcessOnClose=false 后，关闭改为派发 windowClose 事件，由这里经原生接口（非主线程）退出
Neutralino.events.on('windowClose', () => Neutralino.app.exit());
Neutralino.events.on('mainMenuItemClicked', (e) => {
  if (e.detail.id === 'quit') Neutralino.app.exit();
});
