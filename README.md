# 网研ERP（Wyerp）— 社区开源版

**许可证：GNU AGPL-3.0-only。商业使用、修改及 SaaS 运营允许，但须履行 AGPL 的对应源码提供义务。**

> 项目状态：原作者已停止主动开发，供学习、代码审查、二次开发及社区维护。本版本未完成公网生产安全验收。

## 项目介绍

网研ERP是面向 Ozon 卖家的多租户 ERP 内测项目，基于 Node.js、原生 HTML/CSS/JavaScript 和 PostgreSQL。
历史功能涉及商品管理、SKU、在线商品、手动订单与财务统计、会员权限和数据分析。并非所有模块都经过生产级验收。

## 版本来源

- 源仓库：原私有 erp-x20，统一整合分支 release/p1-p3-integration-20261007
- 固定源提交：f6553bb6583f713385c23cc6110e22680fccf6d5（2026-10-13）
- 现有仓库名保留 wangyan-erp-v2；本次发布是旧版统一 Release，不是尚未完成的 V2 重构。
- 本快照不包含其它开发分支尚未统一的改动。

## 快速查看（隔离开发环境）

Windows 建议安装 Node.js 24、PostgreSQL 16+ 和 PowerShell 5.1。当前启动脚本要求 Node.js 至少 22.9.0。

1. 首先阅读根目录 AGENTS.md（后续AI接手规则）和 docs/CONFIGURATION.md（全新电脑从零部署）。再进入 erp/ 目录运行 npm ci。
2. 使用 erp/scripts/setup-local.ps1 创建全新的本机配置与随机密钥，在独立空 PostgreSQL 数据库执行迁移。
3. 使用 erp/scripts/bootstrap-admin.ps1 仅在空库创建首个 admin，执行 doctor-local.ps1 通过检查后再启动 start.ps1。
4. 用浏览器访问 127.0.0.1:8765 进行登录，并安装 extensions/wyerp-collector 采集助手；必须真实验收采集箱持久化。

**未经安全评估、配置及测试，禁止直接把软件开放到公网，也不得连接原业务数据库。** 本仓库未保证零配置部署。

## 开源范围与限制

详见 docs/OPEN_SOURCE_SCOPE.md。
本次发布经筛选的统一 Release ERP 源码和筛选自有代码整理的浏览器采集插件源码（extensions/wyerp-collector，社区版0.4.44），不提供客户数据、真实数据库、密钥、私人联系方式、合同、第三方软件原包与授权未确认的活动插件私有接口。因此不是最新活动插件的全功能商业安装包。

旧“无人值守订单自动同步 / 插件心跳自动同步”方案已永久废止，禁止误开启；用户手动发起的 Ozon 官方 API 同步另按已有功能边界处理。

## 法律与维护

本项目中有权授权的原创代码采用 GNU AGPL-3.0-only，全文见 LICENSE。修改版通过网络向用户提供服务时应遵守第13条相应源码提供义务。
依赖包、第三方组件与商标分别受其各自许可证和条款约束，详见 THIRD_PARTY_NOTICES.md。
原作者不承诺持续开发、商用支持、SLA 或生产可用性；社区可以自行 fork、维护与改进。

> 隐私提醒：本开源仓库不包含原作者的数据库、店铺资料、公司资料和邮件账户设置，相关服务需使用者自行配置。

隐私收口：社区发行快照不包含合同原文或模板、测试夹具、内部验收文档、运营资料及本机诊断脚本；测试脚本已从 npm 对外命令列表移除。

## 安装与使用文档
- 配置与换机：docs/CONFIGURATION.md
- 用户使用说明：docs/USER_GUIDE.md
- 浏览器插件安装：docs/EXTENSION_INSTALL.md
- 插件源码与版权边界：docs/PLUGIN_PROVENANCE.md

## 换电脑或换AI优先阅读
- AGENTS.md：接手规则与禁止事项
- docs/CONFIGURATION.md：空数据库、密钥、首次admin、命令执行顺序
- docs/DEPLOYMENT_STATUS.md：已测试和缺少真实环境验证的功能
- docs/FEATURE_PARITY.md：开源插件与活动插件的功能差异

首次管理员自动创建、密码保管和异常处理统一见 docs/ADMIN_SETUP.md。默认使用安全随机密码，禁止在聊天或日志输出。

- API填写位置、密钥加密、邮件覆盖修复与配置风险：docs/API_CONFIGURATION.md

## 浏览器采集插件：用户安装

当前公开插件版本由 extensions/wyerp-collector/manifest.json 管理，可从GitHub Releases下载同版本 WyerpCollector-v版本号.zip，解压后双击 Install-Collector.cmd 启动安装引导。下载完整源码也可直接双击仓库根目录同名CMD。

安装助手会自动检查插件、打开Edge扩展管理页和插件目录、把选择路径复制到剪贴板；用户仍需要在Edge中开启开发人员模式，并点击加载解压缩的扩展确认。详细图文文字步骤请看 docs/EXTENSION_INSTALL.md。

开发者打包运行 tools/Build-CollectorPackage.ps1，文件名自动使用manifest版本，绝不能混用版本。
**目前尚未发布正式ERP EXE一键安装器**；未来集成要求见 docs/INSTALLER_PLUGIN_INTEGRATION.md。

Windows EXE单机版预览：安装层源码及隔离验收详情请阅读installer/README.md。已验证EXE解包、新PostgreSQL17的67项迁移、随机admin、手动Windows服务启动/重启/停止及数据保护；图形安装真实点击、浏览器采集和正式卸载仍未完成。不可宣称正式安装包已通过全部验收。

2026-10-22预览7已完成GUI安装/管理器真实按钮启动重启关闭/GUI卸载及保留数据的独立QA；预览8仅修改启动器API/Worker就绪检查，已由QA3实测readiness通过、并核对新EXE资源与SHA256，未重复进行完整GUI首次安装测试。正式新机安装、采集插件入库、旧数据重装恢复、退出进行中业务任务的一致性仍待测试。安装、构建及换AI操作详见 installer/README.md。
