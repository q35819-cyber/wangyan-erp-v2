# 网研ERP应用入口：AGPL-3.0 开源快照

本程序来自统一 Release 固定源提交 f6553bb6583f713385c23cc6110e22680fccf6d5。
Node.js >=20，npm ci，单独配置 PostgreSQL 与 Secrets。
Windows 标准启动入口：在本目录运行 PowerShell start.ps1。

原软件尚未独立验证为安全的公网生产版本，本次开源未提供浏览器采集插件和真实业务数据。
请阅读仓库根目录 docs/DEPLOYMENT.md，不要启用已废止的订单自动同步机制。

社区浏览器采集插件位于仓库根目录 extensions/wyerp-collector，安装方法见 docs/EXTENSION_INSTALL.md。
