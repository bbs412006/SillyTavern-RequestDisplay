# SillyTavern Request Display

一个 SillyTavern 第三方扩展，以悬浮状态条显示当前最新 API 请求的状态。

## 功能

- 🔮 **实时显示** 当前请求的 API 来源、模型名称、内容摘要和 Token 数
- ✨ **呼吸流光** 请求进行中紫→青渐变流光边框动画
- ✅ **状态指示** 完成绿色 / 已停止橙色 / 空闲暗色
- 📋 **历史记录** 点击展开下方紧凑列表，按时间倒序
- 🔘 **极简模式** 点击切换为 36px 小圆点，只显示状态图标
- 📱 **移动端适配** 自动全宽、增大触摸目标
- 🖱️ **可拖拽** 拖拽移动位置，刷新后自动恢复

## 安装

### 方式一：通过酒馆安装（推荐）

1. 打开 SillyTavern → ⚙️ 扩展 → 安装扩展
2. 输入本仓库的 Git URL：
   ```
   https://github.com/你的用户名/SillyTavern-RequestDisplay
   ```
3. 点击安装，刷新页面即可使用

### 方式二：手动安装

```bash
cd SillyTavern/public/scripts/extensions/third-party/
git clone https://github.com/你的用户名/SillyTavern-RequestDisplay request-display
```

重启 SillyTavern 即可。

## 使用

- 安装后页面底部会出现悬浮状态条
- **点击状态条** → 切换完整/极简模式
- **点击 ▼** → 展开/收起历史记录
- **拖拽状态条** → 移动位置（位置自动保存）

## 许可

MIT License
