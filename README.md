# Jellyfin supports plugins for VR

为 **Jellyfin Web** 增加 VR 视频播放能力的 JavaScript 插件。

支持通过 **JavaScript Injector** 注入 Jellyfin Web，主要面向 **Meta Quest / WebXR** 环境。

---

## 功能

* 支持 VR180
* 支持 VR360
* 支持 SBS 左右格式
* 支持 OU / TB 上下格式
* 支持 WebXR
* 面向 Meta Quest Browser
* 保留 Jellyfin 海报墙和媒体库体验
* 无需修改 Jellyfin Server 核心代码

---

## 安装

推荐使用 **Jellyfin JavaScript Injector**。

### 1. 安装 JavaScript Injector

进入：

```text
Jellyfin
→ 控制台
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

安装后重启 Jellyfin。

---

### 2. 添加 VR 插件

下载：

```text
jellyfin-vr-player-v2.js
```

进入：

```text
Jellyfin
→ 控制台
→ JS Injector
→ Add Script
```

名称填写：

```text
Jellyfin VR Player
```

将 `jellyfin-vr-player-v2.js` 的全部代码复制到 JavaScript Code 中。

启用：

```text
Enabled
```

然后保存。

---

### 3. 使用

刷新 Jellyfin Web。

进入：

```text
媒体库
→ 影片
→ 播放
```

如果插件加载成功，播放器中会出现 VR 相关入口。

Meta Quest 推荐直接使用：

```text
Meta Quest Browser
→ Jellyfin Web
→ 影片
→ VR
```

使用 JavaScript Injector 后，Quest 不需要单独安装 Tampermonkey。

---

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

---

## 视频类型

支持的主要格式：

```text
VR180
VR360
SBS
OU / TB
```

其中：

* `SBS`：左右眼画面左右排列
* `OU / TB`：左右眼画面上下排列

高分辨率 VR 视频建议尽可能使用 Jellyfin 的：

```text
Direct Play
```

避免服务器实时转码。

---

## 更新

下载最新版：

```text
jellyfin-vr-player-v2.js
```

进入：

```text
控制台
→ JS Injector
→ Jellyfin VR Player
```

使用新代码替换旧代码并保存。

然后刷新 Jellyfin Web。

---

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

选择：

```text
Disable
```

或者直接删除脚本即可。

---

## 致谢

特别感谢 **Mix1C** 的：

**Jellyfin-360VR-Player**

https://github.com/Mix1C/Jellyfin-360VR-Player

该项目为本项目提供了 Jellyfin Web + VR 播放的实现思路和重要参考。

`jellyfin-vr-player-v2.js` 在这一思路启发下继续探索 VR180、VR360、SBS、OU / TB、WebXR 和 Meta Quest 等功能。

感谢 Mix1C 对 Jellyfin VR 播放方向的探索。

---

## Credits

Special thanks to **Mix1C** and the original **Jellyfin-360VR-Player** project:

https://github.com/Mix1C/Jellyfin-360VR-Player

The original project provided important inspiration for extending Jellyfin Web with VR playback functionality.

This project continues exploring Jellyfin VR playback with a focus on WebXR, Meta Quest, VR180, VR360 and stereoscopic video.

---

## License

This project is licensed under the **GNU General Public License**.

See:

```text
LICENSE
```

for the full license terms.

---

## Disclaimer

This is an unofficial third-party Jellyfin project.

It is not affiliated with or endorsed by Jellyfin.

---

## Support

如果项目对你有帮助，欢迎：

* Star
* Issue
* Pull Request
* Feature Request
