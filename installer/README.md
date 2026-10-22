# 网研ERP Windows EXE单机版（预览候选，未正式发布）

本工程不修改现有ERP商品、订单及数据库业务逻辑。由系统自带.NET Framework C#编译器生成可自解压的Windows安装EXE，附带Node24、PostgreSQL17、ERP运行依赖、采集插件、桌面管理器和ERP后台服务。

## 普通用户设计

EXE双击安装，需要一次Windows管理员授权。安装目录默认为Program Files下的WyerpERP Community；私有数据位于ProgramData的WyerpERP-Community。两者分离，避免升级时覆盖业务数据。

自动选择本机ERP端口8765至8799，PG端口55441至55499，并分配集群内部独立端口。选定后写入私有install-settings.json，日后启动重启保持端口。

首次自动创建独立PG实例、角色和wyerp_community_local新库、执行67份迁移、唯一admin和安全随机43字符密码。密码仅保存于本机secrets/initial-admin-password.txt，不写入仓库或日志。

桌面管理器按钮：启动、重启、打开ERP网页、安装采集插件、查看一次性管理员密码、关闭后台。Node ERP和PG由两个仅手动启动的Windows专有服务管理；没有开机自动启动。重复点击启动不会新开第二套集群。关闭浏览器标签页不停止服务；点击管理器退出/停止才停服务。

关闭操作先结束专属ERP节点树，再安全停止专属PG服务；会保留数据、密钥和管理员资料，不结束电脑上其他Node或PG服务。

重要风险：Windows停止ERP服务时可能强制结束在途Node任务；不要在进行订单同步、保存或其他写入任务期间退出。已加退出确认，但尚未证明运行中任务完全无损退出，正式发布前必须验证。

浏览器采集插件自动放到稳定路径，用户仍须在Edge/Chrome开启开发人员模式并手动确认加载，安装器无法绕过浏览器权限。

## 当前真实隔离测试（2026-10-22）

源码基准：公开仓库64efda49，所有安装器源文件新增在installer下，原业务模块未改。
候选EXE在本机路径 D:\WyerpIsolatedDeployQA-20261022\EXE发布候选\WyerpERP-Community-Setup-v0.1.0-preview2.exe

已通过：
- 完整EXE编译，大小94.77MB，内嵌4748文件，Node和PG/ERP组件完整。
- 从EXE原始嵌入ZIP解压出一套独立QA3安装目录，不使用先前成功的QA数据库。
- QA3真实PostgreSQL17 initdb与角色创建、67/67数据迁移、唯一admin和安全随机密码生成。
- 注册两个手动启动的专属Windows服务，安装结束时均Stopped。
- 启动服务后 /health/ready 返回200；跨不同工具运行窗口保持可用；不重复启动新实例。
- 重启后保持18767端口，停止后ERP/PG专属端口18767与55443都已释放、数据库和密钥仍在。
- 第一套独立QA服务与用户正式业务Release始终未碰触。
- 发现并修复了打包后旧doctor对npm/源码布局的依赖，本机PUBLIC_ORIGIN换行匹配、ERP入口/集群内部端口冲突、Windows后台进程退出以及SC注册参数问题。

仍未通过最终发布验收：
- 尚未在全新Windows虚拟机中真实点击EXE GUI安装按钮，检验UAC及桌面快捷方式。
- 真实Edge/Chrome管理员网页登录与1688/Ozon采集入PostgreSQL没有执行。
- 正式卸载器、升级保留密钥/数据、数据库恢复演练尚未开发验收。
- 生产HTTPS、安全签名/SmartScreen信誉、第三方组件再分发许可证与通知需要检查。
- 当前停止ERP可能中断在途任务，不能宣称高并发/订单同步期间无损关闭。

因此安装EXE只是本地预览候选文件，不得向普通用户宣传为正式可用，也不上传GitHub Releases。

## 换AI从源码重新构建

需要Windows 10/11、.NET Framework 4.x内置C#编译器、合法的PostgreSQL17运行组件及Node24的node.exe。先按仓库package-lock.json安装ERP npm依赖，再运行：

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\installer\Build-Exe.ps1 -DependenciesPath "<安全目录>\erp\node_modules" -PostgresRoot "<PostgreSQL17根目录>" -NodeExecutable "<Node24>\node.exe" -OutputDir "<输出目录>"

Build-Exe.ps1自动编译Manager、Service、Setup三部分，读取源码构建内嵌ZIP，生成同名SHA256校验文件。installer下生成的可执行文件不应提交Git；重构源码时必须执行独立隔离数据库端到端测试，不允许复用真实业务数据库。

不能单凭Node/PostgreSQL可用就推断包含它们的EXE允许公众再分发；发布前必须逐项确认第三方许可、署名和必要通知。