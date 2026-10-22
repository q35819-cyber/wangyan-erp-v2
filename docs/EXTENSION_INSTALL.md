# 网研ERP采集插件安装：普通用户版本

当前完整 ERP EXE 安装包尚未发布。浏览器插件安装助手可简化操作，但Edge/Chrome对于未上架商店的扩展仍要求用户在浏览器内确认加载。

## 推荐安装方法：下载插件ZIP

1. 从 GitHub Releases 下载 WyerpCollector-v版本号.zip。
2. 右键选择「全部解压缩」，把目录放在「文档」等固定位置，之后不要随意移动/删除。
3. 双击解压包最外层 Install-Collector.cmd。
4. 安装助手会自动检查版本和插件文件、复制准确目录到剪贴板、打开Edge扩展管理页和本机文件夹。
5. 在Edge管理页面开启「开发人员模式」，点击「加载解压缩的扩展」，在弹出的选文件夹窗口粘贴已复制的目录，确认。
6. 安装后在浏览器扩展菜单固定「网研ERP · 开源采集助手」图标。

以上流程不能绕过浏览器安全确认。不得要求用户编辑注册表、修改企业组策略、关闭浏览器防护或随便点击来源不明的弹窗。

## 如果下载整个ERP源码

完整解压GitHub源码后双击根目录 Install-Collector.cmd。安装助手会自动找到 extensions/wyerp-collector/，用户无需手工找manifest.json。

也可以在仓库根目录PowerShell运行：

    .\tools\Install-Collector.ps1

Chrome用户运行：

    .\tools\Install-Collector.ps1 -Browser Chrome

只做文件检查、不开浏览器：

    .\tools\Install-Collector.ps1 -CheckOnly

## 如果自动引导无法运行：手动安装

- Edge浏览器地址栏输入 edge://extensions/
- Chrome浏览器地址栏输入 chrome://extensions/
- 开启页面上的「开发人员模式」
- 点击「加载解压缩的扩展」或「加载已解压的扩展程序」
- 选择压缩包解压出来的 WyerpCollector-v版本号 文件夹；完整源码版则选 extensions/wyerp-collector
- 正确目录内第一层能直接看到 manifest.json。不要选ZIP或上层目录。

## 安装后实际验收

1. 在同一浏览器访问 http://127.0.0.1:8765，登录新的ERP账号。
2. 打开1688/Ozon商品详情页，等待SKU、价格和图片实际加载。
3. 手动采集，返回ERP采集箱核对新增商品，最终以PostgreSQL真实保存结果为准。
4. 插件显示图标不代表采集功能或后端数据写入已通过测试。

## 版本同步与升级

版本号唯一来源：extensions/wyerp-collector/manifest.json。
开发者在仓库根目录运行 tools/Build-CollectorPackage.ps1 会自动生成 dist/WyerpCollector-vX.Y.Z.zip 和 .sha256。同版本压缩包内部目录也命名为 WyerpCollector-vX.Y.Z，禁止版本混用。

源码版：在原目录更新插件源码，扩展管理页点击「重新加载」并刷新商品网页。
独立ZIP版：解压新版本到另一固定目录，在扩展管理页移除旧扩展，加载新目录，确认正常后再删除旧目录。
未来EXE版：安装器把插件放入稳定的程序目录，版本升级不改变此路径，在安装完成页提供按钮自动打开Edge管理页并复制目录。仍需用户最终浏览器确认。

## 常见问题

- 没有图标：浏览器扩展菜单里固定采集助手，刷新商品页。
- 找不到manifest.json：必须完全解压ZIP，不能直接在压缩包预览里运行助手。
- 没有加载按钮：检查开发人员模式和组织管理策略。
- 采集失败：先确认ERP实际运行于8765，且同一浏览器已登录，商品页面加载完全。
- 希望未来减少到只点一次：应先申请浏览器扩展商店上架，通过审核后用户可以从商店确认安装、由浏览器自动更新。当前尚未上架。