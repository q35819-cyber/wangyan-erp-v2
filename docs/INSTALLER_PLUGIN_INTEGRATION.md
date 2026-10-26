# EXE 安装器集成契约：采集插件

目前 Windows 单机 EXE 是**预览候选版**，已有内置插件和管理器指引，但尚未通过另一台全新 Windows 电脑的完整验收；不能宣传为正式稳定版。此文件同时记录预览版的已实现行为与正式发布前的验收要求。

1. 从manifest.json读取插件版本，安装器不得硬编码旧版本号。
2. 将插件安装到固定路径，如安装目录/collector/wyerp-collector。**目录不含版本号**，便于浏览器在升级后保留有效目录。
   单机 EXE 首次初始化会把插件中的默认 8765 本机地址替换成**该安装实例实际选择的 ERP 端口**；首次加载应使用管理器提供的当前实例插件目录。GitHub 源码版默认仍是 8765，不能将其直接当作任意动态端口实例的已配置插件。
3. 当前预览版的插件入口在**所选程序目录**的 `WyerpERP-Manager.exe` 中，按钮名为「查看 / 安装采集插件」；独立弹窗显示版本、文件检查、复制插件路径、打开 Edge/Chrome 扩展页。`installer/Control.ps1` 中的 Plugin/PluginCheck 会调用随附 `tools/Install-Collector.ps1`，传入 `-PluginDir`，并在需要时带上实例实际的 `-ErpUrl`。正式发布时可考虑在安装完成页额外增加快捷入口，但不能把未实现的入口写成已完成。
4. 向导自动检查插件文件、复制准确路径、打开Edge扩展管理页面和插件文件夹。
5. 提示用户仅在浏览器中开启开发人员模式、点击加载解压缩、确认文件夹。这是当前未上架插件必须由用户进行的确认。
6. 不要修改系统组策略、注册表强行安装，或向用户承诺个人电脑的未上架插件已经静默安装成功。
7. 给出「打开ERP」和「采集一件测试商品」的后续验收。没有数据库持久化证据不得标记采集功能为PASS。
8. 升级、卸载不得覆盖既有数据库、密钥、店铺和个人信息；安装器应默认保留用户数据，更新前备份，稳定插件目录路径。
9. 要接近完整的一键安装，后续还需提交Edge扩展商店审核；用户同意后由浏览器接管更新。

插件独立压缩包从源码manifest版本自动生成，执行：

    powershell.exe -NoProfile -File .\tools\Build-CollectorPackage.ps1

产物命名：

    dist/WyerpCollector-vX.Y.Z.zip
    dist/WyerpCollector-vX.Y.Z.sha256

ZIP还包含 Install-Collector.cmd、tools/Install-Collector.ps1 和安装说明，供不会PowerShell的用户双击使用。

正式发布EXE前必须在全新Windows电脑测试：独立PostgreSQL全部迁移、admin登录、真实浏览器安装、1688与Ozon采集入库、升级保留配置和密钥。上述部分仍未验收，不能把脚本可运行冒充EXE全功能已通过。