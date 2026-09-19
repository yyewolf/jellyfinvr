# Jellyfin supports plugins for VR

[English](#english) | [中文](#中文)

---

# English

A JavaScript extension that adds VR video playback capabilities to **Jellyfin Web**.

It is mainly designed for **Meta Quest + Jellyfin Web + WebXR**, while keeping the normal Jellyfin media library, poster wall, metadata, and watch-history experience.

> This project is still under development and testing. Compatibility may vary depending on Jellyfin version, browser, device, and video format.

## Features

* VR180
* VR360
* SBS 3D
* OU / Top-Bottom 3D
* WebXR
* Meta Quest Browser
* Keeps the normal Jellyfin library / poster-wall experience
* No modification to Jellyfin Server core code
* Recommended installation through JavaScript Injector

## Recommended Installation: JavaScript Injector

The recommended way to install this project is through **Jellyfin JavaScript Injector**.

This allows the script to be injected into Jellyfin Web on the server side, so client devices such as Meta Quest do not need Tampermonkey or a separate app.

### 1. Install JavaScript Injector

Open Jellyfin and go to:

```text
Dashboard
→ Plugins
→ Repositories
```

Add the JavaScript Injector repository.

For Jellyfin 10.11:

```text
https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/10.11/manifest.json
```

For Jellyfin 10.10.7:

```text
https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/10.10/manifest.json
```

Then go to:

```text
Dashboard
→ Plugins
→ Catalog
```

Install:

```text
JavaScript Injector
```

Restart Jellyfin after installation.

## 2. Add the VR Script

Download:

```text
jellyfin-vr-player-v2.js
```

Then go to:

```text
Dashboard
→ JS Injector
→ Add Script
```

Recommended script name:

```text
Jellyfin VR Player
```

Paste the full contents of:

```text
jellyfin-vr-player-v2.js
```

into the JavaScript Code field.

Enable:

```text
Enabled
```

and save.

## 3. Use

Refresh Jellyfin Web.

Open:

```text
Library
→ Movie
→ Play
```

If the script loads correctly, the player's settings menu gains a
**Watch in VR** entry:

```text
Player
→ Settings (gear icon)
→ Watch in VR
```

Nothing is added to the player's control bar, so Jellyfin looks untouched until
you open that menu.

On Meta Quest, simply use:

```text
Meta Quest Browser
→ Jellyfin Web
→ Movie
→ Settings
→ Watch in VR
```

No Tampermonkey or separate Quest application is required when using JavaScript Injector.

## Recommended Architecture

```text
NAS
 ↓
Jellyfin Server
 ↓
JavaScript Injector
 ↓
jellyfin-vr-player-v2.js
 ↓
Jellyfin Web
 ↓
WebXR
 ↓
Meta Quest
```

## Supported Video Types

Main target formats:

```text
VR180
VR360
SBS
OU / Top-Bottom
```

* `SBS`: left-eye and right-eye images arranged side by side
* `OU / TB`: left-eye and right-eye images arranged vertically

For high-resolution VR content, **Direct Play** is strongly recommended whenever possible.

## Updating

Download the latest version of:

```text
jellyfin-vr-player-v2.js
```

Then go to:

```text
Dashboard
→ JS Injector
→ Jellyfin VR Player
```

Replace the old script with the new version and save.

Refresh Jellyfin Web afterward.

## Uninstall

Go to:

```text
Dashboard
→ JS Injector
```

Find:

```text
Jellyfin VR Player
```

Then disable or delete the script.

## Compatibility

| Platform             | Status                    |
| -------------------- | ------------------------- |
| Jellyfin Web         | ✅ Main target             |
| JavaScript Injector  | ✅ Recommended             |
| Chrome               | 🧪 Testing                |
| Edge                 | 🧪 Testing                |
| Meta Quest Browser   | 🧪 Main target            |
| Quest 2              | 🧪 Testing                |
| Quest 3              | 🧪 Testing                |
| Quest 3S             | 🧪 Testing                |
| Jellyfin Android App | ❌ Not currently supported |
| Jellyfin TV App      | ❌ Not currently supported |

## Troubleshooting

### "Watch in VR" does not appear in the player menu

The entry is added to the player's settings menu, not to the control bar. Start
playback, then open the gear icon in the player.

If it is still missing, check:

```text
Dashboard
→ JS Injector
```

Make sure:

```text
Jellyfin VR Player
```

exists and is enabled.

Try a hard refresh:

```text
Ctrl + F5
```

or:

```text
Ctrl + Shift + R
```

On Meta Quest Browser, close the Jellyfin page and open it again.

If the menu entry still does not show up, your Jellyfin build may render its
player menu differently. You can start the VR player directly from the browser
console as a fallback:

```text
jellyfinVR.open()
```

### VR mode does not start

Check:

* WebXR support
* Browser permissions
* HTTPS / secure context requirements
* JavaScript console errors
* Whether the browser supports `immersive-vr`

### Video plays but is not displayed in VR

The normal video element may be playing correctly while the VR renderer failed to start.

Check:

* VR mode
* Projection mode
* Stereo mode
* WebXR availability
* Browser console

## Why This Project Exists

Apps such as SKYBOX and 4XVR are excellent VR players, but when browsing a NAS directly, you often lose the full Jellyfin-style media-library experience.

The goal is to keep this workflow:

**Poster wall → Movie details → Metadata → Play**

while adding VR playback support.

## Credits

Special thanks to **Mix1C** and the original project:

**Jellyfin-360VR-Player**

https://github.com/Mix1C/Jellyfin-360VR-Player

The original project provided important inspiration for extending Jellyfin Web with VR / 360° playback functionality.

This project continues exploring that idea with a focus on:

* VR180
* VR360
* SBS
* OU / Top-Bottom
* WebXR
* Meta Quest
* VR playback controls
* Jellyfin integration

Many thanks to Mix1C for the original exploration and inspiration.

## License

This project is released under the **GNU General Public License**.

See:

```text
LICENSE
```

for the complete license terms.

## Disclaimer

This is an unofficial third-party Jellyfin project.

It is not affiliated with or endorsed by Jellyfin.

## Contributing

Feedback and contributions are welcome:

* Issues
* Bug reports
* Feature requests
* Pull requests

GitHub:

https://github.com/JiaruiGe/jellyfinvr

---

# 中文

一个为 **Jellyfin Web** 增加 VR 视频播放能力的 JavaScript 扩展。

主要面向 **Meta Quest + Jellyfin Web + WebXR**，同时保留 Jellyfin 原有的媒体库、海报墙、元数据和观看历史体验。

> 本项目目前仍处于开发和测试阶段。实际兼容性可能受到 Jellyfin 版本、浏览器、设备和视频格式影响。

## 功能

* VR180
* VR360
* SBS 3D
* OU / 上下 3D
* WebXR
* Meta Quest Browser
* 保留 Jellyfin 原有媒体库 / 海报墙体验
* 无需修改 Jellyfin Server 核心代码
* 推荐通过 JavaScript Injector 安装

## 推荐安装方式：JavaScript Injector

推荐使用 **Jellyfin JavaScript Injector** 安装本项目。

这种方式可以由 Jellyfin 服务端统一向 Jellyfin Web 注入脚本，因此 Meta Quest 等客户端无需安装 Tampermonkey，也不需要安装单独的 Quest 应用。

### 1. 安装 JavaScript Injector

打开 Jellyfin，进入：

```text
控制台
→ 插件
→ 存储库
```

添加 JavaScript Injector 插件仓库。

Jellyfin 10.11：

```text
https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/10.11/manifest.json
```

Jellyfin 10.10.7：

```text
https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/10.10/manifest.json
```

然后进入：

```text
控制台
→ 插件
→ Catalog
```

安装：

```text
JavaScript Injector
```

安装完成后重启 Jellyfin。

## 2. 添加 VR 脚本

下载：

```text
jellyfin-vr-player-v2.js
```

然后进入：

```text
控制台
→ JS Injector
→ Add Script
```

建议脚本名称填写：

```text
Jellyfin VR Player
```

将：

```text
jellyfin-vr-player-v2.js
```

中的完整代码复制到 JavaScript Code 中。

开启：

```text
Enabled
```

然后保存。

## 3. 使用

刷新 Jellyfin Web。

进入：

```text
媒体库
→ 影片
→ 播放
```

如果脚本成功加载，播放器的设置菜单中会出现 **Watch in VR** 选项：

```text
播放器
→ 设置（齿轮图标）
→ Watch in VR
```

播放器控制栏不会新增任何按钮，因此在打开该菜单之前，Jellyfin 界面保持原样。

Meta Quest 推荐直接使用：

```text
Meta Quest Browser
→ Jellyfin Web
→ 影片
→ 设置
→ Watch in VR
```

使用 JavaScript Injector 后，无需在 Quest 上额外安装 Tampermonkey 或独立应用。

## 推荐架构

```text
NAS
 ↓
Jellyfin Server
 ↓
JavaScript Injector
 ↓
jellyfin-vr-player-v2.js
 ↓
Jellyfin Web
 ↓
WebXR
 ↓
Meta Quest
```

## 支持的视频类型

主要目标格式：

```text
VR180
VR360
SBS
OU / 上下
```

* `SBS`：左右眼画面左右排列
* `OU / TB`：左右眼画面上下排列

对于高分辨率 VR 视频，建议尽可能使用 **Direct Play**。

## 更新

下载最新版：

```text
jellyfin-vr-player-v2.js
```

然后进入：

```text
控制台
→ JS Injector
→ Jellyfin VR Player
```

使用新代码替换旧代码并保存。

之后刷新 Jellyfin Web。

## 卸载

进入：

```text
控制台
→ JS Injector
```

找到：

```text
Jellyfin VR Player
```

选择禁用或删除即可。

## 兼容性

| 平台                   | 状态      |
| -------------------- | ------- |
| Jellyfin Web         | ✅ 主要目标  |
| JavaScript Injector  | ✅ 推荐    |
| Chrome               | 🧪 测试中  |
| Edge                 | 🧪 测试中  |
| Meta Quest Browser   | 🧪 主要目标 |
| Quest 2              | 🧪 测试中  |
| Quest 3              | 🧪 测试中  |
| Quest 3S             | 🧪 测试中  |
| Jellyfin Android App | ❌ 暂不支持  |
| Jellyfin TV App      | ❌ 暂不支持  |

## 故障排除

### 播放器菜单中没有 "Watch in VR"

该入口位于播放器的设置菜单中，而不是控制栏。请先开始播放，再点击播放器中的齿轮图标。

如果仍然没有，请进入：

```text
控制台
→ JS Injector
```

确认：

```text
Jellyfin VR Player
```

存在且已经启用。

可以尝试强制刷新：

```text
Ctrl + F5
```

或者：

```text
Ctrl + Shift + R
```

Quest Browser 可以关闭 Jellyfin 页面后重新打开。

如果菜单入口仍然不出现，说明你的 Jellyfin 版本渲染播放器菜单的方式不同。
可以在浏览器控制台中直接启动 VR 播放器作为备用方式：

```text
jellyfinVR.open()
```

### VR 模式无法启动

检查：

* WebXR 是否可用
* 浏览器权限
* HTTPS / 安全上下文要求
* JavaScript Console 是否有报错
* 浏览器是否支持 `immersive-vr`

### 视频能播放，但没有进入 VR

可能是普通视频元素已经成功播放，但 VR Renderer 没有成功启动。

请检查：

* VR Mode
* Projection Mode
* Stereo Mode
* WebXR
* Browser Console

## 为什么做这个项目

SKYBOX、4XVR 等应用是非常优秀的 VR 播放器，但直接通过 NAS 浏览媒体时，通常会失去 Jellyfin 风格的完整媒体库体验。

我希望保留：

**海报墙 → 影片详情 → 元数据 → 播放**

这种流程，同时加入 VR 播放能力。

## 致谢

特别感谢 **Mix1C** 和原项目：

**Jellyfin-360VR-Player**

https://github.com/Mix1C/Jellyfin-360VR-Player

原项目为 Jellyfin Web 增加 VR / 360° 播放功能提供了重要思路和启发。

本项目在这一思路基础上继续探索：

* VR180
* VR360
* SBS
* OU / 上下
* WebXR
* Meta Quest
* VR 播放控制
* Jellyfin 集成

非常感谢 Mix1C 对 Jellyfin VR 播放方向所做的探索。

## License

本项目采用 **GNU General Public License** 发布。

完整许可证内容请查看：

```text
LICENSE
```

## Disclaimer

本项目是非官方第三方 Jellyfin 项目。

与 Jellyfin 官方不存在隶属、合作或官方认可关系。

## Contributing

欢迎：

* Issue
* Bug Report
* Feature Request
* Pull Request

GitHub：

https://github.com/JiaruiGe/jellyfinvr
