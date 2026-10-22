# 网研 ERP Windows EXE 安装器（0.1.0-preview7）

## 当前状态

本仓库的 installer/Build-Exe.ps1 可以在 Windows 上编译单个 EXE，内含 ERP Node.js 业务代码、Node24、PostgreSQL17、浏览器采集插件、Windows 网研 ERP 管理器和独立卸载程序。保留现有 2 个 API 节点与 1 个后台节点架构，仍通过 Edge/Chrome 浏览器使用，不改动ERP商品/订单业务逻辑。

2026-10-22 已通过 Windows WinForms GUI 安装和 GUI 卸载闭环的独立本机QA；尚未验证新Windows虚拟机、正式用户数据恢复/升级、真实浏览器采集，属于未公开的预览候选。

## 安装与使用体验

- 双击安装 EXE，经管理员 UAC 许可，程序写入 Program Files/WyerpERP Community，数据、PostgreSQL和密钥写入 ProgramData/WyerpERP-Community，两个目录分离。
- 优先选择 ERP 端口8765、PostgreSQL 端口55441，冲突时自动检查备用端口，并配置不会冲突的集群内部端口；记录在数据目录的 install-settings.json，重启保持端口不变。
- 创建社区独立PG集群和角色，67项当前数据库迁移全部执行，唯一管理员 admin 的初始43字符随机密码只保存在本机 secrets/initial-admin-password.txt。用户应在成功网页登录后妥善保存密码，才可删除这个一次性文件。
- 安装桌面和开始菜单的“网研 ERP”，打开Windows管理器可启动、重启、打开ERP网页、引导安装浏览器采集插件、查看一次性管理员密码、关闭后台。
- 两个专用Windows服务（ERP和PostgreSQL）均为手动启动，不会开机自动启动。关闭网页不停止后台；点击管理器退出/停止才结束本实例服务。不能按系统全局进程名结束Node或PG。
- 开始菜单增加“卸载网研 ERP”，在Windows应用卸载列表中登记入口。卸载器单独保存在数据目录 tools/WyerpERP-Uninstall.exe，程序及快捷方式可被同步清理，数据库、用户账号、API配置、加密密钥默认保留。
- 浏览器采集扩展必须由用户在 Edge/Chrome 扩展管理页手动确认开启开发人员模式及加载已解压目录。EXE不能绕过浏览器的安全确认。
- 退出运行中任务可能中断尚未完成的保存或订单同步，管理器会提示确认，不能宣称已验证无损退出。

## 2026-10-22 真实本机隔离测试

全部测试在 D:/WyerpIsolatedDeployQA-20261022 的专用全新PG实例/端口完成，未访问正式 Release 数据库。

- PASS：同一预览7 EXE 中4749个文件完整，Windows WinForms安装窗口自动触发与用户点击相同的开始安装事件，建立空白PG17、67/67迁移、唯一admin、随机密钥；自动创建桌面、开始菜单及卸载快捷方式。
- PASS：专属Windows ERP和PostgreSQL服务均为Manual，安装结束后均Stopped；桌面管理器实际Win32按钮点击启动、重启、关闭后台三步，HTTP健康检查与端口一致。
- PASS：由同一安装器复制到数据目录的GUI卸载程序成功注销ERP/PG专属服务、删除程序目录与快捷方式，保留真实PG数据目录、管理员文件和加密密钥。
- 已修复问题：Windows PowerShell5.1不支持不带UTF-8 BOM的中文脚本及部分新Join-Path参数格式；本机HTTP PUBLIC_ORIGIN必须为空；非默认ERP端口必须配置不重叠的集群端口；卸载程序必须位于数据目录才能同步删除安装目录。
- 仍待验收：全新Win10/Win11独立虚拟机点击式安装/UAC、Windows设置卸载列表UI、真实Chrome/Edge管理员登录、1688/Ozon实际采集入PostgreSQL、已有数据重新安装/升级/备份恢复、运行中的订单任务无损退出、代码签名与第三方Node/PG及依赖再分发授权检查。

特别提醒：卸载后数据保留，当前EXE会拒绝将含原数据的目录当成空白首次安装覆盖。正式发布前需要补齐安全的“恢复已有数据/重装”功能，不能让普通用户删除数据目录。

## AI换机重新构建与安全要求

Windows机器需.NET Framework4.x C#编译器、合法PG17发行组件、Node24，以及与公开erp/package-lock.json对应的node_modules。命令示例：

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\installer\Build-Exe.ps1 -DependenciesPath "<干净目录>\erp\node_modules" -PostgresRoot "<PG17发行目录>" -NodeExecutable "<Node24目录>\node.exe" -OutputDir "<安全输出目录>"

构建会在临时暂存目录将PS1转换为带BOM UTF-8后打包，编译管理器、ERP服务、卸载程序和单文件安装EXE，生成SHA256。installer目录下的二进制被忽略，不上传GitHub源码分支；不要将数据库、私钥、作者原私人文件上传。EXE仍为本地预览候选，不得作为正式安装包向公众发布。